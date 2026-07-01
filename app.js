const STORAGE_KEY = "jizhunxian_state_v1";
const USER_KEY = "jizhunxian_user_v1";
const API_BASE = "";
const REFRESH_MS = 60 * 1000;
const DEFAULT_HISTORY_SIZE = 30;
const HISTORY_PAGE_SIZE = 20;

const presets = [
  ["161725", "招商中证白酒指数A"],
  ["110022", "易方达消费行业股票"],
  ["005827", "易方达蓝筹精选混合"],
  ["003096", "中欧医疗健康混合A"],
  ["320007", "诺安成长混合"],
  ["000001", "华夏成长混合"],
  ["002001", "华夏回报混合A"],
  ["260108", "景顺长城新兴成长混合A"]
];

const defaultState = {
  funds: ["161725", "110022", "005827", "003096"],
  holdings: {
    "161725": 12000,
    "110022": 8000,
    "005827": 10000,
    "003096": 6000
  },
  alerts: [],
  sort: "custom"
};

let state = loadState();
let quotes = new Map();
let historyCache = new Map();
let fundSearch = [];
let refreshTimer = null;
let stateSyncTimer = null;
let activeDetailCode = null;
let activeHistorySize = DEFAULT_HISTORY_SIZE;
let currentUser = loadUser();
let loginMode = "phone";
let emailCodeCooldownTimer = null;
let emailCodeCooldown = 0;

const $ = (id) => document.getElementById(id);
const els = {
  marketStatus: $("marketStatus"),
  metricCount: $("metricCount"),
  metricAvg: $("metricAvg"),
  metricProfit: $("metricProfit"),
  metricRisk: $("metricRisk"),
  marketInsight: $("marketInsight"),
  actionBoard: $("actionBoard"),
  portfolioSummary: $("portfolioSummary"),
  userChip: $("userChip"),
  loginOpenBtn: $("loginOpenBtn"),
  loginOverlay: $("loginOverlay"),
  loginCloseBtn: $("loginCloseBtn"),
  loginMode: $("loginMode"),
  loginName: $("loginName"),
  loginPhone: $("loginPhone"),
  loginEmail: $("loginEmail"),
  loginCode: $("loginCode"),
  sendCodeBtn: $("sendCodeBtn"),
  loginSubmitBtn: $("loginSubmitBtn"),
  fundInput: $("fundInput"),
  addFundBtn: $("addFundBtn"),
  quickList: $("quickList"),
  marketTape: $("marketTape"),
  fundTable: $("fundTable"),
  portfolioList: $("portfolioList"),
  alertFund: $("alertFund"),
  alertType: $("alertType"),
  alertValue: $("alertValue"),
  saveAlertBtn: $("saveAlertBtn"),
  alertList: $("alertList"),
  sortControl: $("sortControl"),
  refreshBtn: $("refreshBtn"),
  pageTitle: $("pageTitle"),
  detailOverlay: $("detailOverlay"),
  detailCloseBtn: $("detailCloseBtn"),
  detailCode: $("detailCode"),
  detailTitle: $("detailTitle"),
  detailRange: $("detailRange"),
  detailStats: $("detailStats"),
  detailDecision: $("detailDecision"),
  historyChart: $("historyChart"),
  historyList: $("historyList")
};

init();

function init() {
  renderQuickList();
  bindEvents();
  renderUser();
  hydrateServerState();
  loadFundSearch();
  renderAll();
  refreshQuotes();
  refreshTimer = window.setInterval(refreshQuotes, REFRESH_MS);
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaultState, ...saved };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  queueStateSync();
}

function loadUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}

function saveUser(user) {
  currentUser = user;
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
  renderUser();
}

async function hydrateServerState() {
  if (!currentUser?.token) return;
  try {
    const data = await apiRequest("/api/me");
    if (data.user) saveUser({ ...currentUser, ...data.user, token: currentUser.token });
    if (data.state) {
      state = { ...defaultState, ...data.state };
      saveState();
      renderAll();
    }
  } catch {
    pulseStatus("服务器同步暂不可用，已使用本地缓存");
  }
}

function queueStateSync() {
  if (!currentUser?.token) return;
  window.clearTimeout(stateSyncTimer);
  stateSyncTimer = window.setTimeout(() => {
    apiRequest("/api/state", {
      method: "POST",
      body: JSON.stringify({ state })
    }).catch(() => pulseStatus("本地已保存，服务器稍后同步"));
  }, 400);
}

async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (currentUser?.token) headers.Authorization = `Bearer ${currentUser.token}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "服务暂不可用");
    error.status = response.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.addFundBtn.addEventListener("click", addFundFromInput);
  els.fundInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addFundFromInput();
  });

  els.refreshBtn.addEventListener("click", refreshQuotes);
  els.saveAlertBtn.addEventListener("click", saveAlert);
  els.loginOpenBtn.addEventListener("click", openLogin);
  els.loginCloseBtn.addEventListener("click", closeLogin);
  els.loginMode.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-login-mode]");
    if (button) setLoginMode(button.dataset.loginMode);
  });
  els.sendCodeBtn.addEventListener("click", sendEmailCode);
  els.loginSubmitBtn.addEventListener("click", submitLogin);
  els.loginOverlay.addEventListener("click", (event) => {
    if (event.target === els.loginOverlay) closeLogin();
  });
  els.detailCloseBtn.addEventListener("click", closeFundDetail);
  els.detailRange.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-days]");
    if (!button || !activeDetailCode) return;
    activeHistorySize = Number(button.dataset.days);
    renderDetailRange();
    loadFundHistory(activeDetailCode, activeHistorySize);
  });
  els.detailOverlay.addEventListener("click", (event) => {
    if (event.target === els.detailOverlay) closeFundDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.detailOverlay.classList.contains("open")) closeFundDetail();
    if (event.key === "Escape" && els.loginOverlay.classList.contains("open")) closeLogin();
  });

  els.sortControl.addEventListener("click", (event) => {
    const target = event.target.closest("button[data-sort]");
    if (!target) return;
    state.sort = target.dataset.sort;
    saveState();
    renderAll();
  });
}

function renderUser() {
  if (!currentUser) {
    els.userChip.innerHTML = `
      <button class="login-trigger" id="loginOpenBtn">
        <span>登录 / 创建账号</span>
        <small>同步自选 · 持仓提醒</small>
      </button>
    `;
    els.loginOpenBtn = $("loginOpenBtn");
    els.loginOpenBtn.addEventListener("click", openLogin);
    return;
  }

  const accountType = currentUser.accountType === "email" ? "邮箱账号" : currentUser.token ? "云端账号" : "本地缓存账号";
  els.userChip.innerHTML = `
    <div class="account-card">
      <div class="avatar">${escapeHtml(currentUser.name.slice(0, 1).toUpperCase())}</div>
      <div>
        <strong>${escapeHtml(currentUser.name)}</strong>
        <span>${accountType}</span>
      </div>
      <button class="logout-btn" id="logoutBtn" title="退出登录">退出</button>
    </div>
  `;
  $("logoutBtn").addEventListener("click", logoutUser);
}

function openLogin() {
  els.loginName.value = currentUser?.name || "";
  els.loginPhone.value = currentUser?.phone || "";
  els.loginEmail.value = currentUser?.email || "";
  els.loginCode.value = "";
  setLoginMode(currentUser?.accountType === "email" ? "email" : "phone");
  els.loginOverlay.classList.add("open");
  els.loginOverlay.setAttribute("aria-hidden", "false");
  window.setTimeout(() => els.loginName.focus(), 0);
}

function closeLogin() {
  els.loginOverlay.classList.remove("open");
  els.loginOverlay.setAttribute("aria-hidden", "true");
}

function setLoginMode(mode) {
  loginMode = mode === "email" ? "email" : "phone";
  els.loginMode.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.loginMode === loginMode);
  });
  document.querySelectorAll(".phone-login-field").forEach((item) => {
    item.hidden = loginMode !== "phone";
  });
  document.querySelectorAll(".email-login-field").forEach((item) => {
    item.hidden = loginMode !== "email";
  });
}

async function sendEmailCode() {
  const email = els.loginEmail.value.trim().toLowerCase();
  if (!isValidEmail(email)) {
    pulseStatus("请输入正确的邮箱地址");
    els.loginEmail.focus();
    return;
  }
  if (emailCodeCooldown > 0) return;

  els.sendCodeBtn.disabled = true;
  try {
    await apiRequest("/api/email-code", {
      method: "POST",
      body: JSON.stringify({ email })
    });
    pulseStatus("验证码已发送，请查收邮箱");
    startEmailCodeCooldown(60);
  } catch (error) {
    pulseStatus(error.message || "验证码发送失败，请稍后再试");
    els.sendCodeBtn.disabled = false;
  }
}

function startEmailCodeCooldown(seconds) {
  emailCodeCooldown = seconds;
  window.clearInterval(emailCodeCooldownTimer);
  updateEmailCodeButton();
  emailCodeCooldownTimer = window.setInterval(() => {
    emailCodeCooldown -= 1;
    updateEmailCodeButton();
    if (emailCodeCooldown <= 0) {
      window.clearInterval(emailCodeCooldownTimer);
      els.sendCodeBtn.disabled = false;
      els.sendCodeBtn.textContent = "发送验证码";
    }
  }, 1000);
}

function updateEmailCodeButton() {
  els.sendCodeBtn.disabled = emailCodeCooldown > 0;
  els.sendCodeBtn.textContent = emailCodeCooldown > 0 ? `${emailCodeCooldown}s` : "发送验证码";
}

async function submitLogin() {
  const name = els.loginName.value.trim() || "养基用户";
  const phone = els.loginPhone.value.trim().replace(/\D/g, "");
  const email = els.loginEmail.value.trim().toLowerCase();
  const code = els.loginCode.value.trim().replace(/\D/g, "");
  if (loginMode === "phone" && !/^1[3-9]\d{9}$/.test(phone)) {
    pulseStatus("请输入 11 位中国大陆手机号");
    els.loginPhone.focus();
    return;
  }
  if (loginMode === "email" && !isValidEmail(email)) {
    pulseStatus("请输入正确的邮箱地址");
    els.loginEmail.focus();
    return;
  }
  if (loginMode === "email" && !/^\d{6}$/.test(code)) {
    pulseStatus("请输入 6 位邮箱验证码");
    els.loginCode.focus();
    return;
  }
  let nextUser = {
    name,
    phone: loginMode === "phone" ? phone : "",
    email: loginMode === "email" ? email : "",
    accountType: loginMode,
    createdAt: currentUser?.createdAt || new Date().toISOString()
  };
  let shouldSyncLocalState = false;
  try {
    const path = loginMode === "email" ? "/api/email-login" : "/api/login";
    const body = loginMode === "email" ? { name, email, code } : { name, phone };
    const data = await apiRequest(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    nextUser = data.user || nextUser;
    if (data.isNewUser) {
      shouldSyncLocalState = true;
    } else if (data.state) {
      state = { ...defaultState, ...data.state };
      saveState();
      renderAll();
    }
  } catch (error) {
    pulseStatus(error.message || "登录服务暂不可用，请稍后再试");
    return;
  }
  saveUser(nextUser);
  if (shouldSyncLocalState) queueStateSync();
  closeLogin();
  pulseStatus(shouldSyncLocalState ? `账号已创建，${name}` : `欢迎回来，${name}`);
}

async function logoutUser() {
  if (currentUser?.token) {
    apiRequest("/api/logout", { method: "POST" }).catch(() => {});
  }
  saveUser(null);
  pulseStatus("已退出账号");
}

function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });
  const titles = { dashboard: "今日看盘", portfolio: "组合持仓", alerts: "智能提醒" };
  els.pageTitle.textContent = titles[view] || "今日看盘";
}

function renderQuickList() {
  els.quickList.innerHTML = presets
    .map(([code, name]) => `<button data-code="${code}" title="${name}">${code} ${name}</button>`)
    .join("");
  els.quickList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-code]");
    if (!button) return;
    addFund(button.dataset.code);
  });
}

function loadFundSearch() {
  const script = document.createElement("script");
  script.src = `https://fund.eastmoney.com/js/fundcode_search.js?rt=${Date.now()}`;
  script.onload = () => {
    if (Array.isArray(window.r)) fundSearch = window.r;
  };
  script.onerror = () => {
    fundSearch = presets.map(([code, name]) => [code, "", name]);
  };
  document.head.appendChild(script);
}

function addFundFromInput() {
  const raw = els.fundInput.value.trim();
  if (!raw) return;
  const code = resolveFundCode(raw);
  if (!code) {
    pulseStatus("没有找到基金代码，可直接输入 6 位代码");
    return;
  }
  addFund(code);
  els.fundInput.value = "";
}

function resolveFundCode(input) {
  if (/^\d{6}$/.test(input)) return input;
  const keyword = input.toLowerCase();
  const hit = fundSearch.find((item) => {
    const [code, pinyin, name, type] = item;
    return (
      String(code).includes(keyword) ||
      String(name).toLowerCase().includes(keyword) ||
      String(pinyin).toLowerCase().includes(keyword) ||
      String(type).toLowerCase().includes(keyword)
    );
  });
  return hit?.[0];
}

function addFund(code) {
  if (state.funds.includes(code)) {
    pulseStatus(`${code} 已在自选`);
    return;
  }
  state.funds.push(code);
  state.holdings[code] = state.holdings[code] || 0;
  saveState();
  renderAll();
  fetchQuote(code);
}

function removeFund(code) {
  state.funds = state.funds.filter((item) => item !== code);
  delete state.holdings[code];
  state.alerts = state.alerts.filter((item) => item.code !== code);
  quotes.delete(code);
  saveState();
  renderAll();
}

async function refreshQuotes() {
  if (!state.funds.length) {
    renderAll();
    return;
  }
  document.body.classList.add("is-refreshing");
  pulseStatus("正在刷新实时估值...");
  try {
    for (const code of state.funds) {
      await fetchQuote(code);
    }
    pulseStatus(`已刷新 ${formatTime(new Date())}`);
  } finally {
    document.body.classList.remove("is-refreshing");
    renderAll();
  }
}

function fetchQuote(code) {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      cleanup();
      quotes.set(code, fallbackQuote(code));
      resolve();
    }, 8000);

    window.jsonpgz = (data) => {
      cleanup();
      quotes.set(code, normalizeQuote(code, data));
      resolve();
    };

    script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    script.onerror = () => {
      cleanup();
      quotes.set(code, fallbackQuote(code));
      resolve();
    };
    document.head.appendChild(script);

    function cleanup() {
      window.clearTimeout(timer);
      delete window.jsonpgz;
      script.remove();
    }
  });
}

function normalizeQuote(code, data) {
  const existing = quotes.get(code) || {};
  return {
    code,
    name: data?.name || existing.name || findName(code),
    nav: parseNumber(data?.dwjz),
    quote: parseNumber(data?.gsz),
    change: parseNumber(data?.gszzl),
    navDate: data?.jzrq || "--",
    quoteTime: data?.gztime || "--",
    live: Boolean(data?.name)
  };
}

function fallbackQuote(code) {
  const existing = quotes.get(code);
  if (existing) return { ...existing, live: false };
  return {
    code,
    name: findName(code),
    nav: null,
    quote: null,
    change: null,
    navDate: "--",
    quoteTime: "接口暂不可用",
    live: false
  };
}

function findName(code) {
  const preset = presets.find((item) => item[0] === code);
  if (preset) return preset[1];
  const hit = fundSearch.find((item) => item[0] === code);
  return hit?.[2] || `基金 ${code}`;
}

function renderAll() {
  renderSortControl();
  renderMetrics();
  renderInsights();
  renderActionBoard();
  renderMarketTape();
  renderFundTable();
  renderPortfolio();
  renderAlerts();
}

function renderSortControl() {
  els.sortControl.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.sort === state.sort);
  });
}

function getRows() {
  const rows = state.funds.map((code, index) => {
    const quote = quotes.get(code) || fallbackQuote(code);
    const holding = Number(state.holdings[code] || 0);
    const profit = quote.change === null ? null : (holding * quote.change) / 100;
    return { ...quote, index, holding, profit };
  });

  return rows.sort((a, b) => {
    if (state.sort === "change") return sortNumber(b.change, a.change);
    if (state.sort === "profit") return sortNumber(b.profit, a.profit);
    if (state.sort === "name") return a.name.localeCompare(b.name, "zh-CN");
    return a.index - b.index;
  });
}

function renderMetrics() {
  const rows = getRows();
  const validChanges = rows.map((row) => row.change).filter((value) => value !== null);
  const avg = validChanges.length ? validChanges.reduce((sum, value) => sum + value, 0) / validChanges.length : null;
  const profit = rows.reduce((sum, row) => sum + (row.profit || 0), 0);
  const totalHolding = rows.reduce((sum, row) => sum + row.holding, 0);
  const biggest = rows.reduce((max, row) => Math.max(max, row.holding), 0);
  const concentration = totalHolding ? biggest / totalHolding : 0;
  const volatility = validChanges.length ? Math.max(...validChanges.map((value) => Math.abs(value))) : 0;

  els.metricCount.textContent = rows.length;
  els.metricAvg.textContent = avg === null ? "--" : `${signed(avg)}%`;
  els.metricAvg.className = trendClass(avg);
  els.metricProfit.textContent = totalHolding ? currency(profit) : "--";
  els.metricProfit.className = trendClass(profit);
  els.metricRisk.textContent = riskLabel(concentration, volatility);
}

function renderInsights() {
  const rows = getRows();
  if (!rows.length) {
    els.marketInsight.innerHTML = `
      <article class="insight-card">
        <span>今日脉冲</span>
        <strong>等待自选</strong>
        <small>添加基金后生成组合观察</small>
      </article>
    `;
    return;
  }

  const valid = rows.filter((row) => row.change !== null);
  const leader = valid.slice().sort((a, b) => b.change - a.change)[0];
  const laggard = valid.slice().sort((a, b) => a.change - b.change)[0];
  const holding = rows.reduce((sum, row) => sum + row.holding, 0);
  const liveCount = rows.filter((row) => row.live).length;
  const latestTime = rows.find((row) => row.quoteTime && row.quoteTime !== "--")?.quoteTime || "--";

  els.marketInsight.innerHTML = `
    <article class="insight-card">
      <span>领涨观察</span>
      <strong class="${trendClass(leader?.change ?? null)}">${leader ? `${leader.name.slice(0, 8)} ${signed(leader.change)}%` : "--"}</strong>
      <small>当前自选里相对最强</small>
    </article>
    <article class="insight-card">
      <span>回撤压力</span>
      <strong class="${trendClass(laggard?.change ?? null)}">${laggard ? `${laggard.name.slice(0, 8)} ${signed(laggard.change)}%` : "--"}</strong>
      <small>优先检查是否触发计划</small>
    </article>
    <article class="insight-card">
      <span>组合资金</span>
      <strong>${holding ? compactCurrency(holding) : "--"}</strong>
      <small>${liveCount}/${rows.length} 只实时估值 · ${latestTime}</small>
    </article>
  `;
}

function renderActionBoard() {
  const rows = getRows();
  const stats = portfolioStats(rows);
  if (!rows.length) {
    els.actionBoard.innerHTML = `
      <article class="action-card primary-action">
        <span>今日决策台</span>
        <strong>先建立自选池</strong>
        <small>添加 3-8 只核心基金后，系统会自动生成盯盘重点。</small>
      </article>
    `;
    return;
  }

  const valid = rows.filter((row) => row.change !== null);
  const topMover = valid.slice().sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
  const heavyRisk = rows
    .filter((row) => row.holding > 0 && row.change !== null)
    .sort((a, b) => Math.abs(b.profit || 0) - Math.abs(a.profit || 0))[0];
  const decision = dailyDecision(stats);
  const watchName = topMover ? topMover.name.slice(0, 10) : "等待实时估值";
  const exposureText = stats.totalHolding
    ? `${compactCurrency(stats.totalHolding)} · 最大单仓 ${percentText(stats.concentration * 100)}`
    : "未录入持仓";

  els.actionBoard.innerHTML = `
    <article class="action-card primary-action">
      <span>今日操作</span>
      <strong>${decision.title}</strong>
      <small>${decision.copy}</small>
    </article>
    <article class="action-card">
      <span>优先盯盘</span>
      <strong class="${trendClass(topMover?.change ?? null)}">${escapeHtml(watchName)}</strong>
      <small>${topMover ? `波动 ${signed(topMover.change)}%，建议 14:45 前再复核一次。` : "刷新后识别波动最大的基金。"}</small>
    </article>
    <article class="action-card">
      <span>仓位状态</span>
      <strong>${exposureText}</strong>
      <small>${positionCopy(stats, heavyRisk)}</small>
    </article>
  `;
}

function renderMarketTape() {
  const rows = getRows();
  if (!rows.length) {
    els.marketTape.innerHTML = `<span class="tape-item"><strong>WAIT</strong><span class="flat">添加基金开始看盘</span></span>`;
    return;
  }

  els.marketTape.innerHTML = rows
    .map((row) => {
      const change = row.change === null ? "--" : `${signed(row.change)}%`;
      const price = row.quote === null ? "--" : row.quote.toFixed(4);
      return `
        <span class="tape-item">
          <strong>${row.code}</strong>
          <span>${escapeHtml(row.name.slice(0, 8))}</span>
          <span>${price}</span>
          <span class="${trendClass(row.change)}">${change}</span>
        </span>
      `;
    })
    .join("");
}

function renderFundTable() {
  const rows = getRows();
  if (!rows.length) {
    els.fundTable.innerHTML = `<div class="empty">还没有自选基金，输入基金代码添加一个。</div>`;
    return;
  }
  els.fundTable.innerHTML = rows
    .map((row) => {
      const changeClass = trendClass(row.change);
      const profitClass = trendClass(row.profit);
      return `
        <article class="fund-row" style="--move-width: ${moveWidth(row.change)}%" data-open="${row.code}" role="button" tabindex="0" aria-label="查看 ${escapeHtml(row.name)} 近几天波动">
          <div class="fund-name">
            <strong>${escapeHtml(row.name)}</strong>
            <small>${row.code} · ${row.live ? "实时估值" : "离线缓存"}</small>
          </div>
          <div class="fund-cell">
            <strong>${row.quote === null ? "--" : row.quote.toFixed(4)}</strong>
            <span>估算净值</span>
          </div>
          <div class="fund-cell">
            <strong class="${changeClass}">${row.change === null ? "--" : `${signed(row.change)}%`}</strong>
            <span>估算涨跌</span>
          </div>
          <div class="fund-cell">
            <strong>${row.nav === null ? "--" : row.nav.toFixed(4)}</strong>
            <span>${row.navDate}</span>
          </div>
          <div class="fund-cell">
            <strong class="${profitClass}">${row.holding ? currency(row.profit || 0) : "--"}</strong>
            <span>${row.quoteTime}</span>
          </div>
          <div class="row-actions" aria-label="基金操作">
            <span class="open-hint">波动</span>
            <button class="delete-btn" title="移除 ${row.code}" data-remove="${row.code}" aria-label="移除 ${escapeHtml(row.name)}">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 7h8" />
                <path d="M10 7V5h4v2" />
                <path d="M6.5 9h11l-.7 9.5a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6.5 9Z" />
                <path d="M10 12v5" />
                <path d="M14 12v5" />
              </svg>
            </button>
          </div>
        </article>
      `;
    })
    .join("");

  els.fundTable.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFund(button.dataset.remove);
    });
  });
  els.fundTable.querySelectorAll("[data-open]").forEach((row) => {
    row.addEventListener("click", () => openFundDetail(row.dataset.open));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFundDetail(row.dataset.open);
      }
    });
  });
}

async function openFundDetail(code) {
  activeDetailCode = code;
  activeHistorySize = DEFAULT_HISTORY_SIZE;
  const quote = quotes.get(code) || fallbackQuote(code);
  els.detailCode.textContent = `${code} · ${quote.live ? "实时估值" : "净值档案"}`;
  els.detailTitle.textContent = quote.name;
  els.detailStats.innerHTML = renderDetailStats(quote, []);
  els.detailDecision.innerHTML = "";
  els.historyList.innerHTML = "";
  els.detailOverlay.classList.add("open");
  els.detailOverlay.setAttribute("aria-hidden", "false");
  renderDetailRange();
  loadFundHistory(code, activeHistorySize);
}

async function loadFundHistory(code, size) {
  const quote = quotes.get(code) || fallbackQuote(code);
  els.historyChart.innerHTML = `<div class="empty">正在加载近 ${size} 次净值波动...</div>`;
  els.historyList.innerHTML = "";
  try {
    const history = await fetchHistory(code, size);
    if (code !== activeDetailCode || size !== activeHistorySize) return;
    const points = mergeCurrentEstimate(quote, history, size);
    els.detailStats.innerHTML = renderDetailStats(quote, points);
    els.detailDecision.innerHTML = renderDetailDecision(quote, points);
    els.historyChart.innerHTML = renderHistoryChart(points);
    els.historyList.innerHTML = renderHistoryList(points);
  } catch {
    if (code !== activeDetailCode || size !== activeHistorySize) return;
    els.detailDecision.innerHTML = "";
    els.historyChart.innerHTML = `<div class="empty">历史净值暂时加载失败，可以稍后再试。</div>`;
  }
}

function closeFundDetail() {
  activeDetailCode = null;
  els.detailOverlay.classList.remove("open");
  els.detailOverlay.setAttribute("aria-hidden", "true");
}

function renderDetailRange() {
  els.detailRange.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.days) === activeHistorySize);
  });
}

async function fetchHistory(code, size) {
  const cacheKey = `${code}:${size}`;
  if (historyCache.has(cacheKey)) return Promise.resolve(historyCache.get(cacheKey));

  const pages = Math.ceil(size / HISTORY_PAGE_SIZE);
  const chunks = [];
  for (let page = 1; page <= pages; page += 1) {
    const chunk = await fetchHistoryPage(code, page);
    chunks.push(...chunk);
    if (chunk.length < HISTORY_PAGE_SIZE) break;
  }

  const history = chunks.slice(0, size).reverse();
  if (!history.length) throw new Error("empty history");
  historyCache.set(cacheKey, history);
  return history;
}

function fetchHistoryPage(code, page) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("history timeout"));
    }, 9000);

    script.onload = () => {
      const data = window.apidata;
      cleanup();
      const history = parseHistoryHtml(data?.content || "");
      if (!history.length) {
        reject(new Error("empty history"));
        return;
      }
      resolve(history);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("history network error"));
    };

    script.src = `https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=${page}&per=${HISTORY_PAGE_SIZE}&sdate=&edate=&rt=${Date.now()}`;
    document.head.appendChild(script);

    function cleanup() {
      window.clearTimeout(timer);
      delete window.apidata;
      script.remove();
    }
  });
}

function parseHistoryHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("tbody tr")]
    .map((row) => {
      const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      return {
        date: cells[0],
        nav: parseNumber(cells[1]),
        accumulative: parseNumber(cells[2]),
        change: parseNumber(String(cells[3] || "").replace("%", "")),
        type: "净值"
      };
    })
    .filter((item) => item.date && item.nav !== null)
    ;
}

function mergeCurrentEstimate(quote, history, size) {
  const points = [...history];
  const quoteDate = String(quote.quoteTime || "").slice(0, 10);
  if (quote.quote !== null && quoteDate) {
    const existing = points.find((item) => item.date === quoteDate);
    if (existing) {
      existing.estimate = quote.quote;
      existing.estimateChange = quote.change;
    } else {
      points.push({
        date: quoteDate,
        nav: quote.quote,
        change: quote.change,
        estimate: quote.quote,
        estimateChange: quote.change,
        type: "估算"
      });
    }
  }
  return points.slice(-size);
}

function renderDetailStats(quote, points) {
  const valid = points.filter((item) => item.nav !== null);
  const first = valid[0]?.nav;
  const last = valid[valid.length - 1]?.nav;
  const rangeChange = first && last ? ((last - first) / first) * 100 : null;
  const swings = valid.map((item) => item.change).filter((value) => value !== null);
  const maxSwing = swings.length ? Math.max(...swings.map((value) => Math.abs(value))) : Math.abs(quote.change || 0);

  return `
    <article class="detail-stat">
      <span>当前估值</span>
      <strong>${quote.quote === null ? "--" : quote.quote.toFixed(4)}</strong>
    </article>
    <article class="detail-stat">
      <span>区间变化</span>
      <strong class="${trendClass(rangeChange)}">${rangeChange === null ? "--" : `${signed(rangeChange)}%`}</strong>
    </article>
    <article class="detail-stat">
      <span>最大单日波动</span>
      <strong>${maxSwing ? `${maxSwing.toFixed(2)}%` : "--"}</strong>
    </article>
  `;
}

function renderDetailDecision(quote, points) {
  const valid = points.filter((item) => item.nav !== null);
  const first = valid[0]?.nav;
  const last = valid[valid.length - 1]?.nav;
  const rangeChange = first && last ? ((last - first) / first) * 100 : null;
  const swings = valid.map((item) => item.change).filter((value) => value !== null);
  const positiveDays = swings.filter((value) => value > 0).length;
  const pressureDays = swings.filter((value) => value < -1.5).length;
  const maxUp = swings.length ? Math.max(...swings) : null;
  const maxDown = swings.length ? Math.min(...swings) : null;
  const current = quote.change;
  const tone = current === null ? "等待估值" : current >= 2 ? "强势波动" : current <= -2 ? "回撤压力" : "正常观察";
  const note =
    pressureDays >= 2
      ? "区间内出现多次明显回撤，适合检查是否和你的原计划一致。"
      : positiveDays >= Math.ceil(swings.length * 0.6)
        ? "区间上涨天数占优，适合关注是否接近你的止盈或调仓线。"
        : "波动暂未形成单边趋势，适合继续观察净值确认。";

  return `
    <article>
      <span>复盘结论</span>
      <strong>${tone}</strong>
      <small>${note}</small>
    </article>
    <article>
      <span>区间胜率</span>
      <strong>${swings.length ? `${positiveDays}/${swings.length}` : "--"}</strong>
      <small>上涨日 / 有效净值日</small>
    </article>
    <article>
      <span>波动边界</span>
      <strong>${maxUp === null ? "--" : `${signed(maxUp)}%`} / ${maxDown === null ? "--" : `${signed(maxDown)}%`}</strong>
      <small>最大单日上涨 / 下跌</small>
    </article>
    <article>
      <span>区间表现</span>
      <strong class="${trendClass(rangeChange)}">${rangeChange === null ? "--" : `${signed(rangeChange)}%`}</strong>
      <small>按当前选择的时间范围估算</small>
    </article>
  `;
}

function renderHistoryChart(points) {
  const valid = points.filter((item) => item.nav !== null);
  if (valid.length < 2) {
    return `<div class="empty">历史点位不足，暂时无法绘制波动图。</div>`;
  }

  const width = 520;
  const height = 230;
  const padX = 28;
  const padY = 28;
  const navs = valid.map((item) => item.estimate ?? item.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const span = max - min || max || 1;
  const step = (width - padX * 2) / Math.max(valid.length - 1, 1);
  const coords = valid.map((item, index) => {
    const value = item.estimate ?? item.nav;
    const x = padX + step * index;
    const y = height - padY - ((value - min) / span) * (height - padY * 2);
    return { ...item, x, y, value };
  });
  const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`;
  const grid = [0, 1, 2, 3]
    .map((index) => {
      const y = padY + ((height - padY * 2) / 3) * index;
      return `<line class="chart-axis" x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" />`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近几天净值波动折线图">
      ${grid}
      <polygon class="chart-area" points="${area}" />
      <polyline class="chart-line" points="${line}" />
      ${coords
        .filter((point, index) => shouldShowChartLabel(index, coords.length))
        .map(
          (point) => `
            <text class="chart-label" x="${point.x}" y="${height - 8}" text-anchor="middle">${point.date.slice(5)}</text>
          `
        )
        .join("")}
      ${coords
        .filter((point, index) => shouldShowChartDot(index, coords.length))
        .map((point) => `<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="3.5" />`)
        .join("")}
      <text class="chart-label" x="${padX}" y="16">${max.toFixed(4)}</text>
      <text class="chart-label" x="${padX}" y="${height - padY - 4}">${min.toFixed(4)}</text>
    </svg>
  `;
}

function shouldShowChartLabel(index, total) {
  if (total <= 12) return true;
  const step = Math.ceil(total / 6);
  return index === 0 || index === total - 1 || index % step === 0;
}

function shouldShowChartDot(index, total) {
  if (total <= 30) return true;
  const step = Math.ceil(total / 18);
  return index === 0 || index === total - 1 || index % step === 0;
}

function renderHistoryList(points) {
  return points
    .slice()
    .reverse()
    .map((item) => {
      const value = item.estimate ?? item.nav;
      const change = item.estimateChange ?? item.change;
      return `
        <article class="history-item">
          <div>
            <strong>${item.date}</strong>
            <span>${item.estimate ? "盘中估算" : item.type}</span>
          </div>
          <div>
            <strong>${value === null ? "--" : value.toFixed(4)}</strong>
            <span>单位净值</span>
          </div>
          <div>
            <strong class="${trendClass(change)}">${change === null ? "--" : `${signed(change)}%`}</strong>
            <span>日增长率</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderPortfolio() {
  const rows = getRows();
  renderPortfolioSummary(rows);
  if (!rows.length) {
    els.portfolioList.innerHTML = `<div class="empty">添加自选后可录入持仓金额。</div>`;
    return;
  }
  const stats = portfolioStats(rows);
  els.portfolioList.innerHTML = rows
    .map((row) => {
      const weight = stats.totalHolding && row.holding ? (row.holding / stats.totalHolding) * 100 : null;
      const plan = rowPlan(row, stats);
      return `
        <article class="portfolio-row" data-open="${row.code}" role="button" tabindex="0" aria-label="查看 ${escapeHtml(row.name)} 走势">
          <div class="fund-name portfolio-open">
            <strong>${escapeHtml(row.name)}</strong>
            <small>${row.code} · 点击看走势</small>
          </div>
          <input type="number" min="0" step="100" value="${row.holding}" data-holding="${row.code}" aria-label="${escapeHtml(row.name)} 持仓金额" />
          <div class="fund-cell">
            <strong class="${trendClass(row.profit)}">${row.holding ? currency(row.profit || 0) : "--"}</strong>
            <span>今日预估</span>
          </div>
          <div class="fund-cell">
            <strong>${weight === null ? "--" : percentText(weight)}</strong>
            <span>仓位占比</span>
          </div>
          <div class="plan-chip ${plan.level}">${plan.text}</div>
          <button class="open-detail-btn" data-detail-open="${row.code}" type="button">走势</button>
        </article>
      `;
    })
    .join("");

  els.portfolioList.querySelectorAll("[data-holding]").forEach((input) => {
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      state.holdings[input.dataset.holding] = Number(input.value || 0);
      saveState();
      renderMetrics();
      renderInsights();
      renderActionBoard();
      renderFundTable();
      renderPortfolioSummary(getRows());
    });
  });
  els.portfolioList.querySelectorAll("[data-detail-open]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openFundDetail(button.dataset.detailOpen);
    });
  });
  els.portfolioList.querySelectorAll("[data-open]").forEach((row) => {
    row.addEventListener("click", () => openFundDetail(row.dataset.open));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFundDetail(row.dataset.open);
      }
    });
  });
}

function renderPortfolioSummary(rows) {
  if (!rows.length) {
    els.portfolioSummary.innerHTML = "";
    return;
  }
  const stats = portfolioStats(rows);
  const active = rows.filter((row) => row.holding > 0).length;
  const biggest = rows
    .filter((row) => row.holding > 0)
    .sort((a, b) => b.holding - a.holding)[0];
  const risk = riskLabel(stats.concentration, stats.volatility);
  els.portfolioSummary.innerHTML = `
    <article>
      <span>总持仓</span>
      <strong>${stats.totalHolding ? compactCurrency(stats.totalHolding) : "--"}</strong>
      <small>${active} 只基金录入金额</small>
    </article>
    <article>
      <span>今日盈亏</span>
      <strong class="${trendClass(stats.profit)}">${stats.totalHolding ? currency(stats.profit) : "--"}</strong>
      <small>按实时估值粗略估算</small>
    </article>
    <article>
      <span>集中度</span>
      <strong>${stats.totalHolding ? percentText(stats.concentration * 100) : "--"}</strong>
      <small>${biggest ? `最大仓：${escapeHtml(biggest.name.slice(0, 8))}` : "暂无最大仓"}</small>
    </article>
    <article>
      <span>风险温度</span>
      <strong>${risk}</strong>
      <small>${positionCopy(stats, biggest)}</small>
    </article>
  `;
}

function renderAlerts() {
  els.alertFund.innerHTML = state.funds
    .map((code) => `<option value="${code}">${code} ${escapeHtml((quotes.get(code) || fallbackQuote(code)).name)}</option>`)
    .join("");

  if (!state.alerts.length) {
    els.alertList.innerHTML = `<div class="empty">还没有提醒规则。可以设置关键涨跌幅提醒。</div>`;
    return;
  }

  els.alertList.innerHTML = state.alerts
    .map((alert, index) => {
      const quote = quotes.get(alert.code) || fallbackQuote(alert.code);
      const current = quote.change ?? 0;
      const hit = alert.type === "up" ? current >= alert.value : current <= -alert.value;
      return `
        <article class="alert-row">
          <div class="fund-name">
            <strong>${escapeHtml(quote.name)}</strong>
            <small>${alert.code}</small>
          </div>
          <div class="fund-cell">
            <strong>${alert.type === "up" ? "涨幅超过" : "跌幅超过"} ${alert.value}%</strong>
            <span>提醒条件</span>
          </div>
          <div class="fund-cell">
            <strong class="${hit ? "rise" : "flat"}">${hit ? "已触发" : "监控中"}</strong>
            <span>当前 ${quote.change === null ? "--" : `${signed(quote.change)}%`}</span>
          </div>
          <button class="delete-btn" title="删除提醒" data-alert-remove="${index}" aria-label="删除提醒">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 7h8" />
              <path d="M10 7V5h4v2" />
              <path d="M6.5 9h11l-.7 9.5a2 2 0 0 1-2 1.8H9.2a2 2 0 0 1-2-1.8L6.5 9Z" />
              <path d="M10 12v5" />
              <path d="M14 12v5" />
            </svg>
          </button>
        </article>
      `;
    })
    .join("");

  els.alertList.querySelectorAll("[data-alert-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      state.alerts.splice(Number(button.dataset.alertRemove), 1);
      saveState();
      renderAlerts();
    });
  });
}

function saveAlert() {
  if (!state.funds.length) return;
  const value = Math.abs(Number(els.alertValue.value || 0));
  if (!value) {
    pulseStatus("提醒阈值需要大于 0");
    return;
  }
  state.alerts.push({
    code: els.alertFund.value,
    type: els.alertType.value,
    value
  });
  saveState();
  renderAlerts();
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortNumber(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function signed(value) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function currency(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2
  }).format(value);
}

function compactCurrency(value) {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return currency(value);
}

function percentText(value) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function trendClass(value) {
  if (value === null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "rise" : "fall";
}

function moveWidth(value) {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(Math.abs(value) * 12, 100).toFixed(1);
}

function riskLabel(concentration, volatility) {
  if (!state.funds.length) return "--";
  const score = concentration * 50 + volatility * 12;
  if (score >= 55) return "偏高";
  if (score >= 30) return "中性";
  return "稳健";
}

function portfolioStats(rows) {
  const validChanges = rows.map((row) => row.change).filter((value) => value !== null);
  const avg = validChanges.length ? validChanges.reduce((sum, value) => sum + value, 0) / validChanges.length : null;
  const profit = rows.reduce((sum, row) => sum + (row.profit || 0), 0);
  const totalHolding = rows.reduce((sum, row) => sum + row.holding, 0);
  const biggest = rows.reduce((max, row) => Math.max(max, row.holding), 0);
  const concentration = totalHolding ? biggest / totalHolding : 0;
  const volatility = validChanges.length ? Math.max(...validChanges.map((value) => Math.abs(value))) : 0;
  return { avg, profit, totalHolding, concentration, volatility };
}

function dailyDecision(stats) {
  if (!state.funds.length) {
    return { title: "先建立自选池", copy: "添加核心基金后，再观察组合涨跌和持仓风险。" };
  }
  if (!stats.totalHolding) {
    return { title: "先录入持仓", copy: "没有金额就无法判断今日盈亏和仓位压力。" };
  }
  if (stats.volatility >= 3 || Math.abs(stats.profit) >= stats.totalHolding * 0.018) {
    return { title: "临近收盘复核", copy: "今日波动较大，建议 14:45 前看一次领涨/回撤基金。" };
  }
  if (stats.concentration >= 0.45) {
    return { title: "检查单仓集中", copy: "最大持仓占比较高，先确认它是否仍符合原计划。" };
  }
  if ((stats.avg ?? 0) > 1.2) {
    return { title: "记录上涨原因", copy: "组合整体偏强，适合记录推动项，避免盘中情绪化操作。" };
  }
  if ((stats.avg ?? 0) < -1.2) {
    return { title: "观察回撤承受", copy: "组合偏弱，先看是否触发你预设的加减仓或止损条件。" };
  }
  return { title: "保持观察", copy: "波动在正常范围，重点看收盘前估值是否继续扩大。" };
}

function positionCopy(stats, focusRow) {
  if (!stats.totalHolding) return "录入持仓金额后生成仓位判断。";
  if (stats.concentration >= 0.45) return "单仓偏集中，建议复核配置比例。";
  if (stats.volatility >= 3) return "盘中波动放大，优先盯住大额持仓。";
  if (focusRow?.profit && Math.abs(focusRow.profit) > stats.totalHolding * 0.01) return "主要盈亏来自少数持仓，适合做复盘。";
  return "仓位分布相对均衡。";
}

function rowPlan(row, stats) {
  if (!row.holding) return { text: "未录入", level: "neutral" };
  const weight = stats.totalHolding ? row.holding / stats.totalHolding : 0;
  if (weight >= 0.45) return { text: "单仓偏重", level: "warn" };
  if ((row.change ?? 0) >= 2.5) return { text: "强势复核", level: "rise-plan" };
  if ((row.change ?? 0) <= -2.5) return { text: "回撤观察", level: "fall-plan" };
  if (Math.abs(row.profit || 0) >= row.holding * 0.018) return { text: "盈亏放大", level: "warn" };
  return { text: "正常跟踪", level: "neutral" };
}

function pulseStatus(text) {
  els.marketStatus.textContent = text;
}

function formatTime(date) {
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

window.addEventListener("beforeunload", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
