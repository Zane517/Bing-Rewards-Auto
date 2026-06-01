/**
 * Bing Rewards 多账号自动化搜索脚本 v1.0
 *
 * 功能：
 *   1. 从 accounts.json 读取多账号配置（含邮箱密码）
 *   2. 自动填充登录（持久化 Edge profile，一次登录永久有效）
 *   3. 每次运行时自动从 Bing 首页抓取热搜作为搜索关键词
 *   4. PC + 移动端自动搜索赚取 Rewards 积分
 *
 * 用法：
 *   node index.js                          # 运行所有启用的账号
 *   node index.js --account 主号           # 只运行指定账号
 *   node index.js --headless               # 无头模式
 *   node index.js --dry-run                # 测试模式（只搜几次）
 *
 * 依赖：
 *   - Node.js >= 18
 *   - 系统安装 Microsoft Edge 浏览器
 *   - npm install playwright dotenv
 *
 * 配置：
 *   cp accounts.example.json accounts.json  # 编辑填入邮箱密码
 *   cp .env.example .env                    # 可选
 *
 * 注意：
 *   首次运行会弹出 Edge 窗口，需要手动完成登录/2FA 验证。
 *   之后 cookie 持久化在 edge-profile/ 目录，无需再次登录。
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ==================== 搜索词库（仅作兜底） ====================
const FALLBACK_WORDS = [
  "今日天气", "最新新闻", "科技资讯", "电影推荐", "美食做法",
  "旅游攻略", "健身教程", "编程教程", "股票行情", "汽车评测",
  "手机推荐", "游戏攻略", "音乐榜单", "动漫推荐", "摄影技巧",
  "机器学习", "人工智能", "量子计算", "新能源汽车", "太空探索",
  "健康饮食", "投资理财", "装修设计", "宠物养护", "在线教育",
  "weather today", "latest news", "technology trends", "best movies",
  "cooking recipes", "travel destinations", "workout routine",
  "javascript tutorial", "stock market today", "car reviews",
];

// ==================== 热搜获取 ====================
async function fetchBingTrending(page, wantedCount = 50) {
  const words = new Set();

  // 策略1: Bing 首页 DOM（用 networkidle 等待 JS 渲染完成）
  try {
    await page.goto("https://www.bing.com/", { waitUntil: "networkidle", timeout: 30000 });
    await sleep(3000);

    const extracted = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // 扫描所有搜索链接，直接提取 q 参数（最可靠）
      document.querySelectorAll("a[href*='q=']").forEach((a) => {
        try {
          const url = new URL(a.href);
          const q = url.searchParams.get("q");
          if (q && q.length >= 2 && q.length <= 50 && !seen.has(q)) {
            seen.add(q);
            results.push(q);
          }
        } catch {}
      });

      // 常见热点区域元素
      const candidates = document.querySelectorAll(
        "a[href*='search?q='], a[href*='/search?'], h3, h2, [role='heading'], " +
        ".tile a, .tr_gr a, .vsathm a, #sh_cp_content a, " +
        ".hpg_title, .content-card h2, .card-title, .headline-title, " +
        "[data-tag] a, [data-hv] a, .tr_cont a, .bt_cont a, " +
        "[class*='trend'] a, [class*='hot'] a, [class*='topic'] a"
      );

      candidates.forEach((el) => {
        let text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 2 || text.length > 50 || seen.has(text)) return;
        const hasChinese = /[\u4e00-\u9fff]/.test(text);
        const wordCount = text.split(/\s+/).filter(w => w.length >= 3).length;
        if (hasChinese || wordCount >= 2) {
          seen.add(text);
          results.push(text);
        }
      });

      return results;
    });

    extracted.forEach((w) => words.add(w));
    log(`  从 Bing 首页提取到 ${extracted.length} 个热搜词`, "info");
  } catch (e) {
    log(`  Bing 首页热搜提取失败: ${e.message.substring(0, 60)}`, "warn");
  }

  // 策略2: Bing 搜索建议 API
  if (words.size < 10) {
    try {
      const suggestionsPage = await page.context().newPage();
      const apiUrl = "https://www.bing.com/AS/Suggestions?qry=&cvid=" + Date.now() + "&mkt=zh-CN&FORM=HDRSC1";
      await suggestionsPage.goto(apiUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
      const body = await suggestionsPage.evaluate(() => document.body.innerText);
      await suggestionsPage.close();

      try {
        const json = JSON.parse(body);
        if (Array.isArray(json)) {
          for (const item of json) {
            if (Array.isArray(item)) {
              item.forEach((i) => { if (i && i.Txt) words.add(i.Txt); });
            }
          }
        }
      } catch {
        const matches = body.matchAll(/"Txt"\s*:\s*"([^"]+)"/g);
        for (const m of matches) { words.add(m[1]); }
      }
      log(`  从 Bing 建议 API 补充到 ${words.size} 个词`, "info");
    } catch {
      log("  Bing 建议 API 不可用", "warn");
    }
  }

  // 策略3: cn.bing.com（中文首页）
  if (words.size < 10) {
    try {
      await page.goto("https://cn.bing.com/?FORM=BEHPTB", { waitUntil: "networkidle", timeout: 20000 });
      await sleep(3000);
      const cnTrends = await page.evaluate(() => {
        return [...document.querySelectorAll("a[href*='search?q='], h3, [class*='hot'] a, [class*='trend'] a, .vsathm a")]
          .map(el => (el.textContent || "").trim())
          .filter(t => t.length >= 2 && t.length <= 40);
      });
      cnTrends.forEach((t) => words.add(t));
      log(`  从 cn.bing.com 补充到 ${words.size} 个词`, "info");
    } catch {
      log("  cn.bing.com 不可用", "warn");
    }
  }

  // 不够的话混入兜底词库
  if (words.size < wantedCount) {
    const shuffled = [...FALLBACK_WORDS].sort(() => Math.random() - 0.5);
    for (const w of shuffled) {
      if (words.size >= wantedCount) break;
      words.add(w);
    }
  }

  const result = [...words].slice(0, wantedCount);
  log(`  最终搜索词池: ${result.length} 个`, "ok");
  return result;
}

// ==================== 工具函数 ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ==================== 日志系统 ====================
let LOG_STREAM = null;

function initLogger() {
  const logDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logDir, `${dateStr}.log`);
  LOG_STREAM = fs.createWriteStream(logPath, { flags: "a" });
  console.log(`  Log file: ${logPath}`);
}

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const icons = { info: " i", ok: " +", warn: " !", err: " x", search: " @", account: " #" };
  const line = `${icons[type] || ""} [${time}] ${msg}`;
  console.log(line);
  if (LOG_STREAM) {
    const plain = `[${time}] [${type.toUpperCase()}] ${msg}`;
    LOG_STREAM.write(plain + "\n");
  }
}

function closeLogger() {
  if (LOG_STREAM) { LOG_STREAM.end(); LOG_STREAM = null; }
}

// ==================== 页面安全检测 ====================
async function pageIsAlive(page) {
  try {
    await page.evaluate(() => 1);
    return true;
  } catch {
    return false;
  }
}

// 热搜缓存（进程内只获取一次）
let _trendingCache = null;

async function getSearchWords(count, pageForFetch = null) {
  if (!_trendingCache && pageForFetch) {
    try {
      _trendingCache = await fetchBingTrending(pageForFetch, Math.max(count + 10, 40));
      log(`  热搜已缓存 (${_trendingCache.length} 词)`, "ok");
    } catch {
      _trendingCache = null;
    }
  }

  const source = _trendingCache || FALLBACK_WORDS;
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  const result = [];
  for (let i = 0; i < count; i++) result.push(shuffled[i % shuffled.length]);
  return result;
}

// ==================== 配置加载 ====================
function loadAccounts() {
  const configPath = path.join(__dirname, "accounts.json");
  if (!fs.existsSync(configPath)) {
    console.log("[!] accounts.json not found.");
    console.log("[!] Copy accounts.example.json to accounts.json and fill in your credentials.");
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);
  if (!config.accounts || config.accounts.length === 0) {
    console.log("[!] No accounts configured in accounts.json.");
    process.exit(1);
  }
  return config.accounts;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { headless: false, dryRun: false, accountFilter: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--headless": opts.headless = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--account": opts.accountFilter = args[++i] || null; break;
    }
  }
  return opts;
}

// ==================== 登录逻辑 ====================

/**
 * 自动登录 Microsoft 账号
 *
 * 核心技巧：
 *   1. page.route() 拦截 GetCredentialType.srf，设 isFidoSupported=false 阻止 FIDO 跳转
 *   2. 导航到 rewards.bing.com/signin 而非 login.live.com
 *   3. 用 page.fill() 替代 page.type() 更快更稳
 */
async function autoLogin(page, account) {
  // 禁用 FIDO/Passkey
  await page.route("**/GetCredentialType.srf*", (route) => {
    try {
      const body = JSON.parse(route.request().postData() || "{}");
      body.isFidoSupported = false;
      route.continue({ postData: JSON.stringify(body) });
    } catch {
      route.continue();
    }
  });

  // 导航到 Rewards 登录页
  await page.goto("https://rewards.bing.com/signin", {
    waitUntil: "domcontentloaded", timeout: 30000,
  }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2000);
  await dismissAllDialogs(page);

  // 检查是否已经登录
  const alreadyLoggedIn = await page.waitForSelector(
    'html[data-role-name="RewardsPortal"]',
    { timeout: 8000 }
  ).then(() => true).catch(() => false);

  if (alreadyLoggedIn) {
    log("  已处于登录状态，跳过登录流程", "ok");
    return;
  }

  // 输入邮箱
  await enterEmail(page, account.email);
  await sleep(2000);
  await dismissAllDialogs(page);

  // 输入密码
  await enterPassword(page, account.password, account);
  await sleep(2000);

  // 等待 Rewards Portal 加载
  await waitForRewardsPortal(page);

  // 处理残留弹窗
  await dismissAllDialogs(page);
}

async function enterEmail(page, email) {
  const emailInput = await page.waitForSelector(
    'input[type="email"], input[name="loginfmt"]',
    { state: "visible", timeout: 15000 }
  ).catch(() => null);

  if (!emailInput) {
    const prefilled = await page.waitForSelector("#userDisplayName", { timeout: 3000 }).catch(() => null);
    if (prefilled) {
      log("  邮箱已预填，跳过", "info");
    } else {
      throw new Error("找不到邮箱输入框");
    }
  }

  if (emailInput) {
    await page.fill('input[type="email"], input[name="loginfmt"]', "");
    await sleep(300);
    await page.fill('input[type="email"], input[name="loginfmt"]', email);
    await sleep(500);

    const nextBtn = await page.waitForSelector(
      'input[type="submit"], button[type="submit"], #idSIButton9',
      { timeout: 5000 }
    );
    await nextBtn.click();
    await sleep(2000);
    log("  邮箱已提交", "info");
  }
}

async function enterPassword(page, password, account) {
  // 跳过 2FA 按钮
  const skip2FA = await page.waitForSelector("#idA_PWD_SwitchToPassword", { timeout: 2000 }).catch(() => null);
  if (skip2FA) {
    await skip2FA.click();
    await sleep(2000);
    log("  跳过 2FA，使用密码登录", "info");
  }

  const passwordInput = await page.waitForSelector(
    'input[type="password"], input[name="passwd"]',
    { state: "visible", timeout: 15000 }
  ).catch(() => null);

  if (!passwordInput) {
    const url = page.url();
    log(`  当前页面: ${url.substring(0, 80)}`, "warn");
    log("  未找到密码输入框，可能触发了安全验证", "warn");
    await handle2FAInteractive(page, account);
    return;
  }

  await page.fill('input[type="password"], input[name="passwd"]', "");
  await sleep(300);
  await page.fill('input[type="password"], input[name="passwd"]', password);
  await sleep(500);

  const signInBtn = await page.waitForSelector(
    'input[type="submit"], button[type="submit"], #idSIButton9',
    { timeout: 5000 }
  );
  await signInBtn.click();
  await sleep(2000);
  log("  密码已提交", "info");
}

async function handle2FAInteractive(page, account) {
  const name = (account && account.name) || "unknown";
  log(`[${name}] 需要 2FA 验证，请在浏览器中操作`, "warn");
  log(`[${name}] 等待手动完成...（最长 3 分钟）`, "warn");

  const start = Date.now();
  while (Date.now() - start < 180000) {
    await sleep(5000);
    try {
      if (await checkLoginStatusQuick(page)) {
        log(`[${name}] 验证通过`, "ok");
        return;
      }
    } catch {}
  }
  log(`[${name}] 验证等待超时`, "warn");
}

async function waitForRewardsPortal(page) {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    await dismissAllDialogs(page);
    const done = await page.waitForSelector(
      'html[data-role-name="RewardsPortal"]',
      { timeout: 3000 }
    ).then(() => true).catch(() => false);

    if (done) {
      log("  登录成功，已进入 Rewards Portal", "ok");
      return;
    }
    await sleep(2000);
  }
  throw new Error("Rewards Portal 登录超时（60秒未进入）");
}

/**
 * 关闭各种弹窗：KMSI、Passkey、Cookie、欢迎页等
 */
async function dismissAllDialogs(page) {
  // KMSI (Keep me signed in)
  try {
    const kmsi = await page.waitForSelector('[data-testid="kmsiVideo"]', { timeout: 1000 }).catch(() => null);
    if (kmsi) {
      const yesBtn = await page.$('button[data-testid="primaryButton"]');
      if (yesBtn) { await yesBtn.click().catch(() => {}); await sleep(500); }
    }
  } catch {}

  // Passkey 弹窗
  try {
    const title = await page.waitForSelector('[data-testid="title"]', { timeout: 800 }).catch(() => null);
    if (title) {
      const text = (await title.textContent() || "").trim();
      if (/sign in faster|passkey|fingerprint|face|pin|登录更快速|通行密钥|指纹|面容/i.test(text)) {
        const skipBtn = await page.waitForSelector(
          'button[data-testid="secondaryButton"], button:has-text("Skip"), button:has-text("跳过")',
          { timeout: 1000 }
        ).catch(() => null);
        if (skipBtn) { await skipBtn.click().catch(() => {}); await sleep(500); }
      }
    }
  } catch {}

  // 通用弹窗关闭按钮
  const dismissSelectors = [
    "#acceptButton", "#bnp_btn_accept", "#cookieConsentContainer button",
    "#iLandingViewAction", "#iShowSkip", "#iNext", "#iLooksGood",
    "#idSIButton9", ".ext-secondary.ext-button", ".c-glyph.glyph-cancel",
    ".maybe-later", "#reward_pivot_earn",
  ];
  for (const sel of dismissSelectors) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 500 });
      if (btn) { await btn.click().catch(() => {}); await sleep(300); }
    } catch {}
  }

  // Bing 隐私遮罩
  try {
    const overlay = await page.$("#bnp_overlay_wrapper");
    if (overlay && (await overlay.isVisible().catch(() => false))) {
      const rejectBtn = await page.$('#bnp_btn_reject, button[aria-label*="Reject" i]');
      const acceptBtn = await page.$("#bnp_btn_accept");
      if (rejectBtn) await rejectBtn.click().catch(() => {});
      else if (acceptBtn) await acceptBtn.click().catch(() => {});
      await sleep(300);
    }
  } catch {}
}

/**
 * 手动登录兜底
 */
async function manualLoginFallback(page) {
  log("请在浏览器中手动登录 Microsoft 账号", "warn");
  log("登录成功后脚本将自动检测并继续", "warn");
  log("等待中...（最长 5 分钟）", "warn");

  const start = Date.now();
  let lastCheck = start;
  while (Date.now() - start < 300000) {
    await sleep(3000);
    if (Date.now() - lastCheck > 10000) {
      log("  仍然在等待登录...", "info");
      lastCheck = Date.now();
    }
    if (await checkLoginStatusQuick(page)) {
      log("  检测到登录成功!", "ok");
      return;
    }
  }
  log("  手动登录等待超时", "warn");
}

async function checkLoginStatusQuick(page) {
  try {
    const cookies = await page.context().cookies();
    for (const c of cookies) {
      if ((c.name === "MUID" || c.name === "RPSSecAuth" || c.name === "WLSSC") && c.value.length > 10) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function checkLoginStatus(page) {
  try {
    const rewardsPortal = await page.$('html[data-role-name="RewardsPortal"]');
    if (rewardsPortal) return true;

    const indicators = [
      "#id_l", "#id_Rewards", "#mectrl_headerPicture",
      'a[aria-label*="Rewards"]', 'a[aria-label*="Microsoft Rewards"]',
      "#id__13", 'span[id*="mectrl"]',
    ];
    for (const sel of indicators) {
      const el = await page.$(sel);
      if (el) return true;
    }

    const cookies = await page.context().cookies();
    for (const c of cookies) {
      if ((c.name === "MUID" || c.name === "RPSSecAuth" || c.name === "WLSSC") && c.value.length > 10) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ==================== 搜索任务 ====================

/**
 * PC 搜索（带页面恢复）
 */
async function doPCSearches(page, count, accountName, persistentContext) {
  const words = await getSearchWords(count, page);
  const bingUrl = "https://www.bing.com/search?q=";
  let completed = 0;
  let consecutiveFails = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (consecutiveFails >= 3) {
      log(`[${accountName}] 连续失败 ${consecutiveFails} 次，尝试重建页面...`, "warn");
      try {
        try { await page.close(); } catch {}
        page = await persistentContext.newPage();
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
        });
        consecutiveFails = 0;
      } catch (e) {
        log(`[${accountName}] 页面重建失败: ${e.message}`, "err");
        return completed;
      }
    }

    try {
      await page.goto(bingUrl + encodeURIComponent(word), {
        waitUntil: "domcontentloaded", timeout: 20000,
      });
      log(`  [${i + 1}/${count}] D "${word}"`, "search");

      await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
      await sleep(rand(500, 1500));
      await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
      await sleep(rand(3000, 7000));

      completed++;
      consecutiveFails = 0;
    } catch (e) {
      log(`  搜索失败 "${word}": ${e.message.substring(0, 60)}`, "warn");
      consecutiveFails++;
      await sleep(2000);
    }
  }

  log(`  PC 搜索: ${completed}/${count} 完成`, completed === count ? "ok" : "warn");
  return completed;
}

/**
 * 移动端搜索
 */
async function doMobileSearches(page, count) {
  const words = await getSearchWords(count, page);
  const bingUrl = "https://www.bing.com/search?q=";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    try {
      await page.goto(bingUrl + encodeURIComponent(word), {
        waitUntil: "domcontentloaded", timeout: 20000,
      });
      log(`  [${i + 1}/${count}] M "${word}"`, "search");

      await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
      await sleep(rand(500, 1500));
      await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 400));
      await sleep(rand(4000, 8000));
    } catch (e) {
      log(`  搜索失败 "${word}": ${e.message.substring(0, 60)}`, "warn");
      await sleep(2000);
    }
  }
}

// ==================== 主流程 ====================
async function processAccount(persistentContext, account, opts) {
  const banner = "#".repeat(44);
  console.log(`\n${banner}`);
  console.log(`  Account: ${account.name} (${account.email})`);
  console.log(`${banner}\n`);

  let page = await persistentContext.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // 检查登录状态（持久化 profile，通常已登录）
  let loggedIn = false;
  try {
    await page.goto("https://rewards.bing.com/", {
      waitUntil: "domcontentloaded", timeout: 20000,
    });
    await sleep(3000);
    await dismissAllDialogs(page);
    loggedIn = await checkLoginStatus(page);
  } catch { /* 忽略 */ }

  if (!loggedIn) {
    log(`[${account.name}] 未登录，开始自动登录...`, "account");
    try {
      await autoLogin(page, account);
      log(`[${account.name}] 登录成功`, "ok");
    } catch (e) {
      log(`[${account.name}] 自动登录失败: ${e.message}`, "err");
      log(`[${account.name}] 请在浏览器中手动完成登录...`, "warn");
      await manualLoginFallback(page);
    }
  } else {
    log(`[${account.name}] 已登录（持久化 profile）`, "ok");
  }

  const pcCount = opts.dryRun ? 2 : (account.pcSearchCount || 30);
  const mobileCount = opts.dryRun ? 2 : (account.mobileSearchCount || 20);

  // PC 搜索
  let pcCompleted = 0;
  if (pcCount > 0) {
    log(`[${account.name}] 开始 PC 搜索 (${pcCount} 次)`, "search");
    pcCompleted = await doPCSearches(page, pcCount, account.name, persistentContext);
  }

  // 移动端搜索
  if (mobileCount > 0) {
    log(`[${account.name}] 开始 Mobile 搜索 (${mobileCount} 次)`, "search");
    let mc;
    try {
      const browser = persistentContext.browser();
      mc = await browser.newContext({
        viewport: { width: 390, height: 844 },
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        locale: "zh-CN",
      });
    } catch (e) {
      log(`[${account.name}] 无法创建 Mobile context: ${e.message}`, "err");
      mc = null;
    }
    if (mc) {
      try {
        const cookies = await persistentContext.cookies();
        if (cookies.length > 0) await mc.addCookies(cookies);
      } catch {}
      const mp = await mc.newPage();
      await doMobileSearches(mp, mobileCount);
      await mc.close();
      log(`[${account.name}] Mobile 搜索完成`, "ok");
    }
  }

  try { await page.close(); } catch {}
  return { name: account.name, email: account.email, status: "OK" };
}

async function main() {
  const opts = parseArgs();
  const allAccounts = loadAccounts();

  let accounts = allAccounts.filter((a) => a.enabled !== false);
  if (opts.accountFilter) {
    accounts = accounts.filter((a) => a.name === opts.accountFilter);
    if (accounts.length === 0) {
      console.log(`[!] No account matching "${opts.accountFilter}"`);
      process.exit(1);
    }
  }

  initLogger();

  console.log("\n========================================");
  console.log("  Bing Rewards - Auto Search v1.0");
  console.log("========================================");
  console.log(`  Mode: ${opts.dryRun ? "DRY RUN (test)" : "LIVE"}`);
  console.log(`  Headless: ${opts.headless ? "Yes" : "No"}`);
  console.log(`  Accounts to process: ${accounts.length}`);
  accounts.forEach((a) => console.log(`    - ${a.name} (${a.email})`));
  console.log("");

  // 持久化 profile —— 一次登录，长期有效
  const userDataDir = path.join(__dirname, "edge-profile");
  const persistentContext = await chromium.launchPersistentContext(userDataDir, {
    channel: "msedge",
    headless: opts.headless,
    slowMo: opts.headless ? 0 : 30,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    locale: "zh-CN",
  });

  const results = [];
  for (const account of accounts) {
    try {
      const result = await processAccount(persistentContext, account, opts);
      results.push(result);
    } catch (e) {
      log(`[${account.name}] 执行异常: ${e.message}`, "err");
      results.push({ name: account.name, email: account.email, status: "FAILED", error: e.message });
    }
  }

  await persistentContext.close().catch(() => {});
  closeLogger();

  console.log("\n========================================");
  console.log("           SUMMARY REPORT");
  console.log("========================================");
  for (const r of results) {
    if (r.status === "FAILED") {
      console.log(`  x ${r.name}: FAILED - ${r.error}`);
    } else {
      console.log(`  + ${r.name}: COMPLETED`);
    }
  }
  console.log("========================================\n");
}

main().catch((err) => {
  console.error(`[!] Fatal: ${err.message}`);
  console.error(err.stack);
  closeLogger();
  process.exit(1);
});
