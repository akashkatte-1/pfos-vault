/**
 * PFOS — Personal Finance Application
 * Offline-first local SQLite persistence via PFOS_DB (db-engine.js)
 */
const PFOS = (() => {
  let state = null;
  let pendingEncryptedBlob = null;
  let activeTab = 'home';
  let planningSubTab = 'loans'; // recurring | loans | bills | budgets | investments
  let timelineFilter = { type: 'ALL', accountId: 'ALL', search: '' };
  let analyticsRange = 'MONTHLY';
  let calendarDate = new Date();
  let selectedCalendarDay = new Date().getDate();
  let chartInstances = {};

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state) openSearchModal();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'PFOS_QUICK_ACTION' && state) {
        handleQuickAction(event.data.action);
      }
    });
  }

  // ==================== UTILITIES ====================
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  function formatINR(num) {
    const val = Number(num) || 0;
    return (val < 0 ? '-' : '') + '₹' + Math.abs(Math.round(val)).toLocaleString('en-IN');
  }
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysAgoISO(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function addFrequencyToDate(isoDate, freq) {
    const d = new Date(isoDate + 'T00:00:00');
    if (freq === 'DAILY') d.setDate(d.getDate() + 1);
    else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7);
    else if (freq === 'QUARTERLY') d.setMonth(d.getMonth() + 3);
    else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function daysUntilDayOfMonth(targetDay) {
    const now = new Date();
    return targetDay - now.getDate();
  }
  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const colors = {
      success: 'bg-emerald-950/95 border-emerald-500/40 text-emerald-200',
      warning: 'bg-amber-950/95 border-amber-500/40 text-amber-200',
      error: 'bg-rose-950/95 border-rose-500/40 text-rose-200',
      info: 'bg-slate-900/95 border-slate-700 text-slate-200'
    };
    const el = document.createElement('div');
    el.className = `pointer-events-auto px-4 py-3 rounded-xl border shadow-xl text-xs font-medium animate-fade-up ${colors[type] || colors.info}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3000);
  }
  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  // Smooth count-up animation for currency & stat values
  function animateValues() {
    document.querySelectorAll('[data-animate-value]').forEach((el) => {
      const target = Number(el.getAttribute('data-animate-value')) || 0;
      const mode = el.getAttribute('data-animate-mode') || 'inr';
      const duration = 550;
      const startTime = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = target * eased;
        if (mode === 'inr') el.textContent = formatINR(current);
        else if (mode === 'neg-inr') el.textContent = '-' + formatINR(Math.abs(current));
        else if (mode === 'pct') el.textContent = Math.round(current) + '%';
        else el.textContent = Math.round(current);
        if (progress < 1) requestAnimationFrame(step);
        else {
          if (mode === 'inr') el.textContent = formatINR(target);
          else if (mode === 'neg-inr') el.textContent = '-' + formatINR(Math.abs(target));
          else if (mode === 'pct') el.textContent = Math.round(target) + '%';
          else el.textContent = Math.round(target);
        }
      };
      requestAnimationFrame(step);
    });

    // Smooth progress bar fills
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-bar-width]').forEach((bar) => {
        bar.style.width = bar.getAttribute('data-bar-width');
      });
    });
  }

  // ==================== DEFAULT SETTINGS & SEEDS ====================
  function defaultNotificationSettings() {
    return {
      dailyReviewEnabled: true,
      dailyReviewTime: '21:00',
      creditCardDueEnabled: true
    };
  }

  function ensureStateDefaults(st) {
    if (!st.reconciliation) st.reconciliation = { dailyReviewDates: [], missedPayments90d: 0 };
    if (!st.notificationSettings) st.notificationSettings = defaultNotificationSettings();
    if (typeof st.notificationSettings.dailyReviewEnabled !== 'boolean') st.notificationSettings.dailyReviewEnabled = true;
    if (typeof st.notificationSettings.creditCardDueEnabled !== 'boolean') st.notificationSettings.creditCardDueEnabled = true;
    if (!st.notificationSettings.dailyReviewTime) st.notificationSettings.dailyReviewTime = '21:00';
    if (!st.assistantMeta) st.assistantMeta = { dismissedByDate: {} };
    if (!st.assistantMeta.dismissedByDate) st.assistantMeta.dismissedByDate = {};
    if (!Array.isArray(st.recurringRules)) st.recurringRules = [];
    return st;
  }

  function getSampleData() {
    return ensureStateDefaults({
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [daysAgoISO(1)], missedPayments90d: 0 },
      notificationSettings: defaultNotificationSettings(),
      assistantMeta: { dismissedByDate: {} },
      accounts: [
        { id: 'acc_sbi', profile: 'PERSONAL', type: 'BANK', name: 'SBI Savings', bankName: 'State Bank of India', masked: '4821', ifsc: 'SBIN0001420', balance: 50800, notes: 'Salary account' },
        { id: 'acc_hdfc', profile: 'PERSONAL', type: 'BANK', name: 'HDFC Savings', bankName: 'HDFC Bank', masked: '9014', ifsc: 'HDFC0000240', balance: 34200, notes: 'Primary UPI' },
        { id: 'acc_cash', profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Cash', masked: '', balance: 4250, notes: '' },
        { id: 'acc_gpay', profile: 'PERSONAL', type: 'WALLET', name: 'UPI Lite', bankName: 'Google Pay', masked: 'okhdfc', balance: 1850, notes: '' }
      ],
      transactions: [
        { id: 'tx_1', profile: 'PERSONAL', type: 'INCOME', amount: 45000, accountId: 'acc_sbi', category: 'Salary', method: 'NETBANKING', merchant: 'Monthly Salary', date: daysAgoISO(10), time: '09:05', source: 'MANUAL', notes: '' },
        { id: 'tx_2', profile: 'PERSONAL', type: 'EXPENSE', amount: 1500, accountId: 'acc_hdfc', category: 'Fuel', method: 'UPI', merchant: 'HPCL Petrol Pump', date: daysAgoISO(2), time: '10:30', source: 'MANUAL', notes: '' },
        { id: 'tx_3', profile: 'PERSONAL', type: 'EXPENSE', amount: 280, accountId: 'acc_gpay', category: 'Food', method: 'UPI', merchant: 'Lunch', date: todayISO(), time: '13:15', source: 'MANUAL', notes: '' }
      ],
      recurringRules: [
        { id: 'rec_1', profile: 'PERSONAL', type: 'INCOME', title: 'Salary', amount: 45000, accountId: 'acc_sbi', category: 'Salary', method: 'NETBANKING', frequency: 'MONTHLY', nextRunDate: daysAgoISO(-11), lastRunDate: daysAgoISO(19), active: true }
      ],
      loans: [],
      obligations: [],
      budgets: [
        { id: 'bg_1', profile: 'PERSONAL', category: 'Food', limit: 5000 },
        { id: 'bg_2', profile: 'PERSONAL', category: 'Fuel', limit: 3000 }
      ],
      goals: [],
      investments: [],
      netWorthHistory: [
        { label: 'Aug', value: 64000 }, { label: 'Sep', value: 72500 }, { label: 'Oct', value: 81000 }, { label: 'Nov', value: 91100 }
      ]
    });
  }

  function getEmptyData() {
    return ensureStateDefaults({
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [], missedPayments90d: 0 },
      notificationSettings: defaultNotificationSettings(),
      assistantMeta: { dismissedByDate: {} },
      accounts: [
        { id: uid('acc'), profile: 'PERSONAL', type: 'BANK', name: 'Primary Bank', bankName: '', masked: '', ifsc: '', balance: 0, notes: '' },
        { id: uid('acc'), profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Cash', masked: '', balance: 0, notes: '' }
      ],
      transactions: [], recurringRules: [], loans: [], obligations: [],
      budgets: [], goals: [], investments: [], netWorthHistory: [{ label: 'Now', value: 0 }]
    });
  }

  async function persistState() {
    try {
      await PFOS_DB.saveState(state);
      updateReminderBadges();
    } catch (err) {
      showToast('Could not save changes: ' + err.message, 'error');
    }
  }

  function byProfile(list) {
    if (!state || state.activeProfile === 'ALL') return list;
    return list.filter((item) => item.profile === state.activeProfile);
  }

  // ==================== RECURRING ENGINE ====================
  async function processDueRecurringRules(silent = false) {
    const today = todayISO();
    let createdCount = 0;
    for (const rule of (state.recurringRules || [])) {
      if (!rule.active || !rule.nextRunDate) continue;
      let guard = 0;
      while (rule.nextRunDate <= today && guard < 12) {
        guard++;
        const now = new Date();
        const tx = {
          id: uid('tx'), profile: rule.profile || 'PERSONAL', type: rule.type || 'EXPENSE',
          amount: Number(rule.amount || 0), accountId: rule.accountId || state.accounts[0]?.id,
          toAccountId: null, category: rule.category || 'Recurring', method: rule.method || 'AUTO',
          merchant: rule.title, date: rule.nextRunDate,
          time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          source: 'RECURRING', isAtm: false, notes: `Recurring (${rule.frequency})`
        };
        applyBalanceImpact(tx, 1);
        state.transactions.unshift(tx);
        rule.lastRunDate = rule.nextRunDate;
        rule.nextRunDate = addFrequencyToDate(rule.nextRunDate, rule.frequency);
        createdCount++;
      }
    }
    if (createdCount > 0) {
      await persistState();
      if (!silent) showToast(`Logged ${createdCount} recurring entr${createdCount === 1 ? 'y' : 'ies'}.`);
    }
    return createdCount;
  }

  async function runRecurringNow(ruleId) {
    const rule = state.recurringRules.find(r => r.id === ruleId);
    if (!rule) return;
    const now = new Date();
    const tx = {
      id: uid('tx'), profile: rule.profile || 'PERSONAL', type: rule.type || 'EXPENSE',
      amount: Number(rule.amount || 0), accountId: rule.accountId || state.accounts[0]?.id,
      toAccountId: null, category: rule.category || 'Recurring', method: rule.method || 'AUTO',
      merchant: rule.title, date: todayISO(),
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      source: 'RECURRING', isAtm: false, notes: `Recurring (${rule.frequency})`
    };
    applyBalanceImpact(tx, 1);
    state.transactions.unshift(tx);
    rule.lastRunDate = todayISO();
    rule.nextRunDate = addFrequencyToDate(todayISO(), rule.frequency);
    await persistState();
    renderCurrentView();
    showToast(`Recorded ${rule.title} (${formatINR(rule.amount)})`);
  }

  async function toggleRecurringActive(ruleId) {
    const r = state.recurringRules.find(x => x.id === ruleId);
    if (!r) return;
    r.active = !r.active;
    await persistState();
    renderCurrentView();
  }

  // ==================== FINANCIAL METRICS ====================
  function computeMetrics() {
    const accounts = byProfile(state.accounts);
    const transactions = byProfile(state.transactions);
    const loans = byProfile(state.loans);
    const obligations = byProfile(state.obligations);
    const investments = byProfile(state.investments);

    const bankBalance = accounts.filter(a => a.type === 'BANK').reduce((s, a) => s + Number(a.balance || 0), 0);
    const cashBalance = accounts.filter(a => a.type === 'CASH').reduce((s, a) => s + Number(a.balance || 0), 0);
    const walletBalance = accounts.filter(a => a.type === 'WALLET').reduce((s, a) => s + Number(a.balance || 0), 0);
    const investmentsValue = investments.reduce((s, i) => s + Number(i.currentValue || 0), 0);

    const liquidAssets = bankBalance + cashBalance + walletBalance;
    const totalAssets = liquidAssets + investmentsValue;

    const creditCards = accounts.filter(a => a.type === 'CREDIT_CARD');
    const creditCardDues = creditCards.reduce((s, c) => s + Number(c.balance || 0), 0);
    const totalCreditLimit = creditCards.reduce((s, c) => s + Number(c.creditLimit || 0), 0);
    const creditUtilization = totalCreditLimit > 0 ? (creditCardDues / totalCreditLimit) * 100 : 0;

    const unpaidObligations = obligations.filter(o => !o.paidThisMonth);
    const upcomingEmis = unpaidObligations.filter(o => o.kind === 'EMI').reduce((s, o) => s + Number(o.amount || 0), 0);
    const upcomingRent = unpaidObligations.filter(o => o.kind === 'RENT').reduce((s, o) => s + Number(o.amount || 0), 0);
    const upcomingInsurance = unpaidObligations.filter(o => o.kind === 'INSURANCE').reduce((s, o) => s + Number(o.amount || 0), 0);
    const upcomingBills = unpaidObligations.filter(o => o.kind === 'BILL').reduce((s, o) => s + Number(o.amount || 0), 0);
    const upcomingSubs = unpaidObligations.filter(o => o.kind === 'SUBSCRIPTION').reduce((s, o) => s + Number(o.amount || 0), 0);

    const borrowedDue = loans.filter(l => l.direction === 'BORROWED' && l.outstanding > 0).reduce((s, l) => s + Number(l.outstanding || 0), 0);
    const lentOutstanding = loans.filter(l => l.direction === 'LENT' && l.outstanding > 0).reduce((s, l) => s + Number(l.outstanding || 0), 0);

    const totalObligations = creditCardDues + upcomingEmis + upcomingRent + upcomingInsurance + upcomingBills + upcomingSubs + borrowedDue;
    const trueFreeMoney = totalAssets - totalObligations;
    const commitmentRatio = totalAssets > 0 ? (totalObligations / totalAssets) * 100 : (totalObligations > 0 ? 100 : 0);

    let risk = { label: 'Healthy', badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25', barClass: 'bg-emerald-500' };
    if (totalObligations > totalAssets) {
      risk = { label: 'Overcommitted', badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/25', barClass: 'bg-rose-500' };
    } else if (commitmentRatio >= 50) {
      risk = { label: 'Moderate', badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/25', barClass: 'bg-amber-500' };
    }

    const netWorth = totalAssets - (creditCardDues + borrowedDue);
    const nowPrefix = todayISO().slice(0, 7);
    const monthTxs = transactions.filter(t => (t.date || '').startsWith(nowPrefix));
    const monthlyIncome = monthTxs.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount || 0), 0);
    const monthlyExpenses = monthTxs.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + Number(t.amount || 0), 0);
    const todaySpending = transactions.filter(t => t.type === 'EXPENSE' && t.date === todayISO()).reduce((s, t) => s + Number(t.amount || 0), 0);
    const todayReceived = transactions.filter(t => t.type === 'INCOME' && t.date === todayISO()).reduce((s, t) => s + Number(t.amount || 0), 0);

    const baseMonthlyExp = Math.max(monthlyExpenses, 25000);
    const emergencyRequired = baseMonthlyExp * 6;
    const emergencySaved = cashBalance + (bankBalance * 0.6);
    const emergencyPct = Math.min(100, Math.round((emergencySaved / emergencyRequired) * 100));

    const savingsRate = monthlyIncome > 0 ? Math.max(0, (monthlyIncome - monthlyExpenses) / monthlyIncome) : 0;
    const savingsPts = Math.min(25, Math.round((savingsRate / 0.30) * 25));
    let creditPts = 20;
    if (totalCreditLimit > 0) {
      const u = creditUtilization / 100;
      creditPts = u <= 0.30 ? 20 : u >= 0.90 ? 0 : Math.round((1 - (u - 0.30) / 0.60) * 20);
    }
    const emergencyPts = Math.min(25, Math.round((emergencySaved / emergencyRequired) * 25));
    const debtRatio = (creditCardDues + borrowedDue) / Math.max(monthlyIncome * 12, 1);
    const debtPts = Math.max(0, Math.min(15, Math.round((1 - debtRatio) * 15)));
    const disciplinePts = Math.max(0, 15 - (state.reconciliation.missedPayments90d || 0) * 5);
    const healthScore = Math.max(0, Math.min(100, savingsPts + creditPts + emergencyPts + debtPts + disciplinePts));

    const reviewedToday = (state.reconciliation.dailyReviewDates || []).includes(todayISO());

    return {
      bankBalance, cashBalance, walletBalance, liquidAssets, investmentsValue, totalAssets,
      creditCardDues, totalCreditLimit, creditUtilization,
      upcomingEmis, upcomingRent, upcomingInsurance, upcomingBills, upcomingSubs,
      upcomingBillsRent: upcomingRent + upcomingInsurance + upcomingBills,
      borrowedDue, lentOutstanding,
      totalObligations, trueFreeMoney, commitmentRatio, risk, netWorth,
      monthlyIncome, monthlyExpenses, todaySpending, todayReceived,
      emergencyRequired, emergencySaved, emergencyPct,
      healthScore, healthBreakdown: { savingsPts, creditPts, emergencyPts, debtPts, disciplinePts, savingsRate: Math.round(savingsRate * 100) },
      reviewedToday
    };
  }

  // ==================== STRICT 2-REMINDER ENGINE (PERSISTED DAILY ONCE IN SQLITE) ====================
  function getActiveReminders() {
    if (!state) return [];
    const m = computeMetrics();
    const ns = state.notificationSettings || defaultNotificationSettings();
    const dismissedByDate = state.assistantMeta?.dismissedByDate || {};
    const today = todayISO();
    const reminders = [];

    const isDismissedToday = (id) => dismissedByDate[id] === today;

    // Reminder 1: End-of-day Daily Expense Review (once per day)
    if (ns.dailyReviewEnabled && !m.reviewedToday && !isDismissedToday('daily_expense_review')) {
      reminders.push({
        id: 'daily_expense_review',
        tag: 'Daily Review',
        severity: 'info',
        title: 'Review today’s expenses',
        body: `You have logged ${formatINR(m.todaySpending)} in expenses today. Confirm everything is up to date.`,
        actions: [
          { label: 'Mark Reviewed', onclick: "PFOS.completeDailyReview()" },
          { label: 'Add Expense', onclick: "PFOS.openTransactionModal('EXPENSE')" },
          { label: 'Dismiss Today', onclick: "PFOS.dismissReminderForToday('daily_expense_review')" }
        ]
      });
    }

    // Reminder 2: Actual Credit Card Due Reminder (only for real cards with balance > 0 & due <= 7 days or overdue)
    if (ns.creditCardDueEnabled) {
      byProfile(state.accounts)
        .filter(a => a.type === 'CREDIT_CARD' && Number(a.balance) > 0)
        .forEach(cc => {
          const alertId = `cc_due_${cc.id}`;
          if (isDismissedToday(alertId)) return;
          const diff = daysUntilDayOfMonth(Number(cc.dueDay) || 5);
          if (diff > 7) return;

          let statusText = `Due in ${diff} days`;
          let sev = 'warning';
          if (diff < 0) { statusText = `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} overdue`; sev = 'danger'; }
          else if (diff === 0) { statusText = 'Due today'; sev = 'danger'; }
          else if (diff === 1) { statusText = 'Due tomorrow'; sev = 'danger'; }

          reminders.push({
            id: alertId,
            tag: 'Credit Card Due',
            severity: sev,
            title: `${cc.name} — ${statusText}`,
            body: `Outstanding balance: ${formatINR(cc.balance)} (Due on day ${cc.dueDay})`,
            actions: [
              { label: 'Pay Card Bill', onclick: `PFOS.openTransactionModal('TRANSFER', '${cc.id}')` },
              { label: 'Dismiss Today', onclick: `PFOS.dismissReminderForToday('${alertId}')` }
            ]
          });
        });
    }

    return reminders;
  }

  function updateReminderBadges() {
    if (!state) return;
    const count = getActiveReminders().length;
    const hb = document.getElementById('header-alert-badge');
    const sb = document.getElementById('sidebar-alert-badge');
    if (hb) { hb.textContent = count; hb.classList.toggle('hidden', count === 0); }
    if (sb) { sb.textContent = count; sb.classList.toggle('hidden', count === 0); }
  }

  async function dismissReminderForToday(id) {
    state.assistantMeta.dismissedByDate = state.assistantMeta.dismissedByDate || {};
    state.assistantMeta.dismissedByDate[id] = todayISO();
    await persistState();
    renderCurrentView();
    showToast('Reminder dismissed for today.', 'info');
  }

  async function completeDailyReview() {
    const d = todayISO();
    if (!state.reconciliation.dailyReviewDates.includes(d)) {
      state.reconciliation.dailyReviewDates.push(d);
    }
    state.assistantMeta.dismissedByDate = state.assistantMeta.dismissedByDate || {};
    state.assistantMeta.dismissedByDate['daily_expense_review'] = d;
    await persistState();
    renderCurrentView();
    showToast('Daily expense review completed.');
  }

  // ==================== NAVIGATION & VIEW ROUTER ====================
  function setTab(tab) {
    activeTab = tab;
    updateNavStyles();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function setPlanningSubTab(sub) { planningSubTab = sub; renderCurrentView(); }
  async function switchProfile(profile) {
    state.activeProfile = profile;
    await persistState();
    document.getElementById('desktop-profile-select').value = profile;
    document.getElementById('mobile-profile-select').value = profile;
    renderCurrentView();
  }
  function updateNavStyles() {
    const titles = {
      home: 'Overview',
      accounts: 'Accounts & Cards',
      timeline: 'Transactions',
      planning: 'Planning & Loans',
      assistant: 'Reminders',
      analytics: 'Analytics',
      settings: 'Settings'
    };
    document.getElementById('header-title').textContent = titles[activeTab] || 'PFOS';
    document.querySelectorAll('.nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `nav-btn w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition ${
        active ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:bg-card hover:text-slate-200 border border-transparent'
      }`;
    });
    document.querySelectorAll('.m-nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `m-nav-btn flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl text-[10px] font-medium transition ${
        active ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-400 hover:text-slate-200'
      }`;
    });
    updateReminderBadges();
  }
  function destroyCharts() {
    Object.values(chartInstances).forEach(ch => { try { ch.destroy(); } catch (_) {} });
    chartInstances = {};
  }
  function renderCurrentView() {
    destroyCharts();
    const container = document.getElementById('app-view');
    if (!container || !state) return;
    if (activeTab === 'home') container.innerHTML = renderHomeTab();
    else if (activeTab === 'accounts') container.innerHTML = renderAccountsTab();
    else if (activeTab === 'timeline') container.innerHTML = renderTimelineTab();
    else if (activeTab === 'planning') container.innerHTML = renderPlanningTab();
    else if (activeTab === 'assistant') container.innerHTML = renderRemindersTab();
    else if (activeTab === 'analytics') {
      container.innerHTML = renderAnalyticsTab();
      setTimeout(initAnalyticsCharts, 40);
    }
    else if (activeTab === 'settings') container.innerHTML = renderSettingsTab();
    updateReminderBadges();
    refreshIcons();
    animateValues();
  }

  // ==================== TAB 1: OVERVIEW ====================
  function renderHomeTab() {
    const m = computeMetrics();
    const reminders = getActiveReminders();
    const recentTxs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).slice(0, 5);
    const upcomingObs = byProfile(state.obligations).filter(o => !o.paidThisMonth).sort((a, b) => a.dueDay - b.dueDay).slice(0, 4);

    return `
      <!-- AVAILABLE BALANCE & COMMITMENTS SUMMARY -->
      <section class="rounded-2xl bg-card border border-slate-800/90 p-5 sm:p-6 shadow-sm animate-fade-up">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <p class="text-xs font-medium text-slate-400">Available Free Balance</p>
            <div class="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums mt-1 ${m.trueFreeMoney >= 0 ? 'text-emerald-400' : 'text-rose-400'}"
                 data-animate-value="${m.trueFreeMoney}" data-animate-mode="inr">${formatINR(m.trueFreeMoney)}</div>
          </div>
          <span class="px-2.5 py-1 rounded-full text-[11px] font-semibold border ${m.risk.badgeClass}">
            ${m.risk.label} · ${Math.round(m.commitmentRatio)}% committed
          </span>
        </div>

        <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden mb-5">
          <div class="h-full ${m.risk.barClass} rounded-full transition-all duration-700 ease-out" style="width: 0%" data-bar-width="${Math.min(100, Math.max(2, m.commitmentRatio))}%"></div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="rounded-xl bg-obsidian/70 border border-slate-800/80 p-3.5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-slate-400">Total Assets</span>
              <span class="text-sm font-bold text-slate-100 tabular-nums" data-animate-value="${m.totalAssets}" data-animate-mode="inr">${formatINR(m.totalAssets)}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400 tabular-nums">
              <div class="flex justify-between"><span>Banks</span><span class="text-slate-200">${formatINR(m.bankBalance)}</span></div>
              <div class="flex justify-between"><span>Cash</span><span class="text-slate-200">${formatINR(m.cashBalance)}</span></div>
              <div class="flex justify-between"><span>Wallets</span><span class="text-slate-200">${formatINR(m.walletBalance)}</span></div>
              <div class="flex justify-between"><span>Investments</span><span class="text-slate-200">${formatINR(m.investmentsValue)}</span></div>
            </div>
          </div>

          <div class="rounded-xl bg-obsidian/70 border border-slate-800/80 p-3.5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-medium text-slate-400">Upcoming Commitments</span>
              <span class="text-sm font-bold text-rose-400 tabular-nums" data-animate-value="${m.totalObligations}" data-animate-mode="neg-inr">-${formatINR(m.totalObligations)}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400 tabular-nums">
              <div class="flex justify-between"><span>Credit Cards</span><span class="text-rose-300">-${formatINR(m.creditCardDues)}</span></div>
              <div class="flex justify-between"><span>EMIs</span><span class="text-rose-300">-${formatINR(m.upcomingEmis)}</span></div>
              <div class="flex justify-between"><span>Rent &amp; Bills</span><span class="text-rose-300">-${formatINR(m.upcomingBillsRent + m.upcomingSubs)}</span></div>
              <div class="flex justify-between"><span>Borrowed</span><span class="text-rose-300">-${formatINR(m.borrowedDue)}</span></div>
            </div>
          </div>
        </div>
      </section>

      <!-- QUICK ACTIONS -->
      <section class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 animate-fade-up stagger-1">
        <button onclick="PFOS.openTransactionModal('EXPENSE')" class="flex items-center justify-center gap-2 p-3 rounded-xl bg-card hover:bg-slate-800 border border-slate-800 text-rose-400 text-xs font-semibold transition active:scale-95"><i data-lucide="minus-circle" class="w-4 h-4"></i> Expense</button>
        <button onclick="PFOS.openTransactionModal('INCOME')" class="flex items-center justify-center gap-2 p-3 rounded-xl bg-card hover:bg-slate-800 border border-slate-800 text-emerald-400 text-xs font-semibold transition active:scale-95"><i data-lucide="plus-circle" class="w-4 h-4"></i> Income</button>
        <button onclick="PFOS.openTransactionModal('TRANSFER')" class="flex items-center justify-center gap-2 p-3 rounded-xl bg-card hover:bg-slate-800 border border-slate-800 text-sky-400 text-xs font-semibold transition active:scale-95"><i data-lucide="arrow-left-right" class="w-4 h-4"></i> Transfer</button>
        <button onclick="PFOS.openVoiceModal()" class="flex items-center justify-center gap-2 p-3 rounded-xl bg-card hover:bg-slate-800 border border-slate-800 text-violet-400 text-xs font-semibold transition active:scale-95"><i data-lucide="mic" class="w-4 h-4"></i> Voice</button>
        <button onclick="PFOS.openSmsModal()" class="col-span-2 sm:col-span-1 flex items-center justify-center gap-2 p-3 rounded-xl bg-card hover:bg-slate-800 border border-slate-800 text-amber-400 text-xs font-semibold transition active:scale-95"><i data-lucide="message-square-text" class="w-4 h-4"></i> Parse SMS</button>
      </section>

      <!-- ACTIVE REMINDERS (ONLY DAILY REVIEW + ACTUAL CREDIT CARD DUES) -->
      ${reminders.length ? `
        <section class="space-y-2 animate-fade-up stagger-2">
          ${reminders.map(r => `
            <div class="rounded-xl border ${r.severity === 'danger' ? 'border-rose-500/35 bg-rose-950/20' : r.severity === 'warning' ? 'border-amber-500/30 bg-amber-950/15' : 'border-slate-800 bg-card'} p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(r.tag)}</span>
                <p class="text-xs font-semibold text-slate-100 mt-0.5">${escapeHtml(r.title)}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(r.body)}</p>
              </div>
              <div class="flex flex-wrap gap-1.5 shrink-0">
                ${r.actions.map(act => `<button onclick="${act.onclick}" class="px-2.5 py-1.5 rounded-lg bg-obsidian hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-200 transition">${escapeHtml(act.label)}</button>`).join('')}
              </div>
            </div>
          `).join('')}
        </section>
      ` : ''}

      <!-- KEY METRICS -->
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-fade-up stagger-3">
        <div onclick="PFOS.setTab('analytics')" class="cursor-pointer rounded-xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <p class="text-xs text-slate-400 mb-1">Net Worth</p>
          <div class="text-xl font-bold text-slate-100 tabular-nums" data-animate-value="${m.netWorth}" data-animate-mode="inr">${formatINR(m.netWorth)}</div>
          <p class="text-[11px] text-slate-400 mt-1 tabular-nums">Today: <span class="text-rose-400 font-medium">${formatINR(m.todaySpending)}</span></p>
        </div>

        <div onclick="PFOS.openHealthBreakdownModal()" class="cursor-pointer rounded-xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <p class="text-xs text-slate-400 mb-1">Health Score</p>
          <div class="flex items-baseline gap-1 tabular-nums">
            <span class="text-xl font-bold ${m.healthScore >= 75 ? 'text-emerald-400' : m.healthScore >= 50 ? 'text-amber-400' : 'text-rose-400'}" data-animate-value="${m.healthScore}" data-animate-mode="int">${m.healthScore}</span>
            <span class="text-xs text-slate-500">/ 100</span>
          </div>
          <p class="text-[11px] text-slate-400 mt-1">View breakdown</p>
        </div>

        <div class="rounded-xl bg-card border border-slate-800 p-4">
          <p class="text-xs text-slate-400 mb-1">Monthly Income</p>
          <div class="text-xl font-bold text-emerald-400 tabular-nums" data-animate-value="${m.monthlyIncome}" data-animate-mode="inr">${formatINR(m.monthlyIncome)}</div>
          <p class="text-[11px] text-slate-400 mt-1 tabular-nums">Expenses: ${formatINR(m.monthlyExpenses)}</p>
        </div>

        <div class="rounded-xl bg-card border border-slate-800 p-4">
          <p class="text-xs text-slate-400 mb-1">Emergency Reserve</p>
          <div class="text-xl font-bold text-slate-100 tabular-nums" data-animate-value="${m.emergencyPct}" data-animate-mode="pct">${m.emergencyPct}%</div>
          <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-2">
            <div class="h-full bg-emerald-500 rounded-full transition-all duration-700 ease-out" style="width:0%" data-bar-width="${m.emergencyPct}%"></div>
          </div>
        </div>
      </section>

      <!-- RECENT ACTIVITY + UPCOMING DUES -->
      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-fade-up stagger-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold">Recent Transactions</h3>
            <button onclick="PFOS.setTab('timeline')" class="text-xs text-emerald-400 hover:underline">View all</button>
          </div>
          <div class="space-y-2">
            ${recentTxs.length ? recentTxs.map(t => renderTxRow(t, true)).join('') : '<p class="text-xs text-slate-500 py-6 text-center">No transactions recorded yet.</p>'}
          </div>
        </div>

        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-semibold">Upcoming Dues</h3>
            <button onclick="PFOS.setTab('planning')" class="text-xs text-emerald-400 hover:underline">Manage</button>
          </div>
          <div class="space-y-2">
            ${upcomingObs.length ? upcomingObs.map(ob => `
              <div class="flex items-center justify-between p-3 rounded-xl bg-obsidian/60 border border-slate-800/80">
                <div>
                  <p class="text-xs font-semibold text-slate-200">${escapeHtml(ob.title)}</p>
                  <p class="text-[11px] text-slate-400">${ob.kind} · Due day ${ob.dueDay}${ob.remainingMonths ? ` · ${ob.remainingMonths}m left` : ''}</p>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-semibold text-rose-400 tabular-nums mr-1">${formatINR(ob.amount)}</span>
                  <button onclick="PFOS.openEditObligationModal('${ob.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.payObligation('${ob.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[11px] font-semibold">Pay</button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-500 py-6 text-center">No pending bills or EMIs this month.</p>'}
          </div>
        </div>
      </section>
    `;
  }

  // ==================== TAB 2: ACCOUNTS & CARDS ====================
  function renderAccountsTab() {
    const accounts = byProfile(state.accounts);
    const groups = [
      { key: 'BANK', title: 'Bank Accounts', icon: 'landmark', accent: 'text-emerald-400' },
      { key: 'CASH', title: 'Cash', icon: 'banknote', accent: 'text-amber-400' },
      { key: 'WALLET', title: 'Digital Wallets', icon: 'smartphone', accent: 'text-sky-400' },
      { key: 'CREDIT_CARD', title: 'Credit Cards', icon: 'credit-card', accent: 'text-rose-400' },
      { key: 'DEBIT_CARD', title: 'Debit Cards', icon: 'id-card', accent: 'text-slate-300' }
    ];
    return `
      <div class="flex flex-wrap items-center justify-between gap-3 animate-fade-up">
        <div>
          <h3 class="text-base font-semibold">Accounts &amp; Cards</h3>
          <p class="text-xs text-slate-400">Manage balances, credit limits, and billing dates</p>
        </div>
        <button onclick="PFOS.openAddAccountModal()" class="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition active:scale-95">
          <i data-lucide="plus" class="w-4 h-4"></i> Add Account
        </button>
      </div>
      <div class="space-y-6 animate-fade-up stagger-1">
        ${groups.map(g => {
          const items = accounts.filter(a => a.type === g.key);
          if (!items.length) return '';
          return `
            <section>
              <h4 class="text-xs uppercase tracking-wider font-semibold text-slate-400 mb-3 flex items-center gap-2"><i data-lucide="${g.icon}" class="w-4 h-4 ${g.accent}"></i> ${g.title} (${items.length})</h4>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                ${items.map(acc => g.key === 'CREDIT_CARD' ? renderCreditCardItem(acc) : renderStandardAccountItem(acc)).join('')}
              </div>
            </section>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderStandardAccountItem(acc) {
    return `
      <div class="rounded-xl bg-card border border-slate-800 p-4 flex flex-col justify-between gap-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-sm font-semibold text-slate-100">${escapeHtml(acc.name)}</p>
            <p class="text-[11px] text-slate-400">${escapeHtml(acc.bankName || acc.type)}${acc.masked ? ` · •••• ${escapeHtml(acc.masked)}` : ''}</p>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-medium">${acc.profile}</span>
        </div>
        <div class="flex items-end justify-between">
          <div>
            ${acc.type === 'DEBIT_CARD'
              ? `<p class="text-xs text-slate-300">Linked: ${escapeHtml(acc.linkedBank || 'Bank')}</p><p class="text-[11px] text-slate-500">Exp: ${escapeHtml(acc.expiry || 'N/A')}</p>`
              : `<p class="text-[11px] text-slate-500">Balance</p><p class="text-xl font-bold text-emerald-400 tabular-nums">${formatINR(acc.balance)}</p>`
            }
          </div>
          <div class="flex items-center gap-1">
            <button onclick="PFOS.openEditAccountModal('${acc.id}')" class="p-2 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition" title="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
            <button onclick="PFOS.deleteAccount('${acc.id}')" class="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
          </div>
        </div>
      </div>
    `;
  }

  function renderCreditCardItem(cc) {
    const limit = Number(cc.creditLimit) || 1, out = Number(cc.balance) || 0;
    const util = Math.min(100, Math.round((out / limit) * 100));
    let levelColor = 'bg-emerald-500', badge = { text: `${util}% used`, cls: 'bg-emerald-500/15 text-emerald-400' };
    if (util >= 75) { levelColor = 'bg-rose-500'; badge = { text: `${util}% used`, cls: 'bg-rose-500/15 text-rose-400' }; }
    else if (util >= 40) { levelColor = 'bg-amber-500'; badge = { text: `${util}% used`, cls: 'bg-amber-500/15 text-amber-400' }; }

    return `
      <div class="rounded-xl bg-card border border-slate-800 p-4 flex flex-col justify-between gap-3">
        <div class="flex items-start justify-between">
          <div><p class="text-sm font-semibold text-slate-100">${escapeHtml(cc.name)}</p><p class="text-[11px] text-slate-400">${escapeHtml(cc.bankName)} · •••• ${escapeHtml(cc.masked || '0000')}</p></div>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.cls}">${badge.text}</span>
        </div>
        <div>
          <div class="flex justify-between text-xs mb-1 tabular-nums"><span class="text-slate-400">Outstanding</span><span class="font-semibold text-rose-400">${formatINR(out)} <span class="text-slate-500 font-normal">/ ${formatINR(limit)}</span></span></div>
          <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden"><div class="h-full ${levelColor} rounded-full transition-all duration-700 ease-out" style="width:0%" data-bar-width="${util}%"></div></div>
        </div>
        <div class="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-[11px]">
          <div><span class="text-slate-500 block">Statement</span><span class="font-medium">Day ${cc.statementDay || 15}</span></div>
          <div><span class="text-slate-500 block">Due Date</span><span class="font-medium text-amber-400">Day ${cc.dueDay || 5}</span></div>
          <div><span class="text-slate-500 block">Min Due</span><span class="font-medium tabular-nums">${formatINR(cc.minDue || Math.round(out * 0.05))}</span></div>
        </div>
        <div class="flex items-center justify-between gap-2 pt-1">
          <button onclick="PFOS.openTransactionModal('TRANSFER', '${cc.id}')" class="flex-1 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs font-semibold transition">Pay Bill</button>
          <button onclick="PFOS.openEditAccountModal('${cc.id}')" class="p-2 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition" title="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
          <button onclick="PFOS.deleteAccount('${cc.id}')" class="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </div>
      </div>
    `;
  }

  // ==================== TAB 3: TRANSACTIONS ====================
  function renderTimelineTab() {
    const accounts = byProfile(state.accounts);
    let txs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    if (timelineFilter.type !== 'ALL') txs = txs.filter(t => t.type === timelineFilter.type);
    if (timelineFilter.accountId !== 'ALL') txs = txs.filter(t => t.accountId === timelineFilter.accountId || t.toAccountId === timelineFilter.accountId);
    if (timelineFilter.search.trim()) {
      const q = timelineFilter.search.toLowerCase();
      txs = txs.filter(t => (t.merchant || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q) || (t.method || '').toLowerCase().includes(q));
    }

    const grouped = {};
    txs.forEach(t => {
      const key = t.date || 'Unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    });
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    return `
      <section class="flex flex-col sm:flex-row gap-2.5 animate-fade-up">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2"></i>
          <input type="text" value="${escapeHtml(timelineFilter.search)}" oninput="PFOS.setTimelineSearch(this.value)" placeholder="Search merchant, category, notes..." class="w-full bg-card border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
        </div>
        <div class="flex gap-2 overflow-x-auto no-scrollbar">
          ${['ALL', 'EXPENSE', 'INCOME', 'TRANSFER'].map(tp => `<button onclick="PFOS.setTimelineType('${tp}')" class="px-3.5 py-2 rounded-xl text-xs font-medium shrink-0 border transition ${timelineFilter.type === tp ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300' : 'bg-card border-slate-800 text-slate-400 hover:text-slate-200'}">${tp === 'ALL' ? 'All' : tp.charAt(0) + tp.slice(1).toLowerCase()}</button>`).join('')}
          <select onchange="PFOS.setTimelineAccount(this.value)" class="bg-card border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300">
            <option value="ALL">All Accounts</option>
            ${accounts.map(a => `<option value="${a.id}" ${timelineFilter.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="space-y-4 animate-fade-up stagger-1">
        ${dates.length ? dates.map(dt => {
          const list = grouped[dt];
          const daySpent = list.filter(x => x.type === 'EXPENSE').reduce((s, x) => s + Number(x.amount), 0);
          const dayIn = list.filter(x => x.type === 'INCOME').reduce((s, x) => s + Number(x.amount), 0);
          const label = dt === todayISO() ? `Today · ${dt}` : dt === daysAgoISO(1) ? `Yesterday · ${dt}` : dt;
          return `
            <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-2.5">
              <div class="flex items-center justify-between pb-2 border-b border-slate-800/80">
                <h4 class="text-xs font-semibold text-slate-300">${escapeHtml(label)}</h4>
                <div class="flex items-center gap-3 text-[11px] tabular-nums">
                  ${dayIn > 0 ? `<span class="text-emerald-400 font-semibold">+${formatINR(dayIn)}</span>` : ''}
                  ${daySpent > 0 ? `<span class="text-rose-400 font-semibold">-${formatINR(daySpent)}</span>` : ''}
                </div>
              </div>
              <div class="space-y-2">${list.map(t => renderTxRow(t, true)).join('')}</div>
            </div>
          `;
        }).join('') : '<div class="rounded-2xl bg-card border border-slate-800 p-10 text-center text-xs text-slate-500">No matching transactions.</div>'}
      </section>
    `;
  }

  function renderTxRow(t, allowActions) {
    const acc = state.accounts.find(a => a.id === t.accountId);
    const toAcc = t.toAccountId ? state.accounts.find(a => a.id === t.toAccountId) : null;
    const isInc = t.type === 'INCOME', isTr = t.type === 'TRANSFER';
    const icon = isInc ? 'arrow-down-left' : isTr ? 'arrow-left-right' : 'arrow-up-right';
    const iconBg = isInc ? 'bg-emerald-500/12 text-emerald-400' : isTr ? 'bg-sky-500/12 text-sky-400' : 'bg-rose-500/12 text-rose-400';
    const amtColor = isInc ? 'text-emerald-400' : isTr ? 'text-sky-400' : 'text-rose-400';
    const sign = isInc ? '+' : isTr ? '⇄ ' : '-';

    return `
      <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-obsidian/60 border border-slate-800/80 hover:border-slate-700/80 transition">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0"><i data-lucide="${icon}" class="w-4 h-4"></i></div>
          <div class="min-w-0">
            <p class="text-xs font-semibold text-slate-100 truncate">
              <span class="font-mono text-[11px] text-slate-500 mr-1.5">${escapeHtml(t.time || '12:00')}</span>${escapeHtml(t.merchant || t.category)}
            </p>
            <p class="text-[11px] text-slate-400 truncate">${escapeHtml(acc ? acc.name : 'Account')}${toAcc ? ` → ${escapeHtml(toAcc.name)}` : ''} · ${escapeHtml(t.category || t.type)}</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-sm font-semibold tabular-nums ${amtColor} mr-1">${sign}${formatINR(t.amount)}</span>
          ${allowActions ? `
            <button onclick="PFOS.openEditTransactionModal('${t.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
            <button onclick="PFOS.deleteTransaction('${t.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ==================== TAB 4: PLANNING & LOANS ====================
  function renderPlanningTab() {
    const subTabs = [
      { id: 'loans', label: 'Loans & EMIs' },
      { id: 'recurring', label: 'Recurring' },
      { id: 'bills', label: 'Bills & Calendar' },
      { id: 'budgets', label: 'Budgets & Goals' },
      { id: 'investments', label: 'Investments' }
    ];
    let body = '';
    if (planningSubTab === 'recurring') body = renderRecurringSubTab();
    else if (planningSubTab === 'loans') body = renderLoansEmisSubTab();
    else if (planningSubTab === 'bills') body = renderBillsCalendarSubTab();
    else if (planningSubTab === 'budgets') body = renderBudgetsGoalsSubTab();
    else if (planningSubTab === 'investments') body = renderInvestmentsSubTab();

    return `
      <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1 animate-fade-up">
        ${subTabs.map(s => `<button onclick="PFOS.setPlanningSubTab('${s.id}')" class="px-4 py-2 rounded-xl text-xs font-semibold shrink-0 border transition ${planningSubTab === s.id ? 'bg-emerald-500 text-slate-950 border-emerald-500' : 'bg-card border-slate-800 text-slate-300 hover:bg-slate-800'}">${s.label}</button>`).join('')}
      </div>
      <div class="animate-fade-up stagger-1">${body}</div>
    `;
  }

  function renderLoansEmisSubTab() {
    const loans = byProfile(state.loans), emis = byProfile(state.obligations).filter(o => o.kind === 'EMI');
    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Loans (Lent &amp; Borrowed)</h3><button onclick="PFOS.openAddLoanModal()" class="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-semibold">+ Add Loan</button></div>
          <div class="space-y-2.5">
            ${loans.length ? loans.map(l => {
              const paidSoFar = Math.max(0, Number(l.principal || 0) - Number(l.outstanding || 0));
              const paidPct = l.principal > 0 ? Math.min(100, Math.round((paidSoFar / l.principal) * 100)) : 0;
              return `
                <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 space-y-2.5">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${l.direction === 'LENT' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">${l.direction}</span>
                        <span class="text-xs font-semibold text-slate-100">${escapeHtml(l.person)}</span>
                      </div>
                      <p class="text-[11px] text-slate-400 mt-1 tabular-nums">
                        Principal: ${formatINR(l.principal)} · ${l.direction === 'LENT' ? 'Received' : 'Paid'}: ${formatINR(paidSoFar)}${l.dueDate ? ` · Due: ${escapeHtml(l.dueDate)}` : ''}
                      </p>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <div class="text-right mr-1">
                        <p class="text-sm font-bold tabular-nums ${l.direction === 'LENT' ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(l.outstanding)}</p>
                        ${l.outstanding > 0 ? `<button onclick="PFOS.openSettleLoanModal('${l.id}')" class="mt-0.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 font-semibold transition">Record Pay</button>` : '<span class="text-[10px] text-emerald-400 font-medium">Settled</span>'}
                      </div>
                      <button onclick="PFOS.openEditLoanModal('${l.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                      <button onclick="PFOS.deleteLoan('${l.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>
                  <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full ${l.direction === 'LENT' ? 'bg-emerald-500' : 'bg-sky-500'} rounded-full transition-all duration-700 ease-out" style="width:0%" data-bar-width="${paidPct}%"></div>
                  </div>
                </div>
              `;
            }).join('') : '<p class="text-xs text-slate-500 text-center py-6">No loans recorded.</p>'}
          </div>
        </div>

        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Active EMIs</h3><button onclick="PFOS.openAddObligationModal('EMI')" class="px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 text-xs font-semibold">+ Add EMI</button></div>
          <div class="space-y-2.5">
            ${emis.length ? emis.map(e => `
              <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><p class="text-xs font-semibold text-slate-100">${escapeHtml(e.title)}</p><p class="text-[11px] text-slate-400 mt-0.5">Due day ${e.dueDay} · Remaining: ${e.remainingMonths || 0}m</p></div>
                <div class="flex items-center gap-1.5">
                  <span class="text-sm font-bold text-amber-400 tabular-nums mr-1">${formatINR(e.amount)}</span>
                  ${e.paidThisMonth ? '<span class="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 font-semibold">Paid</span>' : `<button onclick="PFOS.payObligation('${e.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-semibold">Pay</button>`}
                  <button onclick="PFOS.openEditObligationModal('${e.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteObligation('${e.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-500 text-center py-6">No EMIs configured.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  function renderRecurringSubTab() {
    const rules = byProfile(state.recurringRules || []);
    return `
      <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div><h3 class="text-sm font-semibold">Recurring Transactions</h3><p class="text-xs text-slate-400 mt-0.5">Scheduled Daily, Weekly, Monthly, Quarterly, or Yearly entries</p></div>
          <div class="flex gap-2">
            <button onclick="PFOS.processDueRecurringRules(false).then(() => PFOS.renderCurrentView())" class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium">Run Due</button>
            <button onclick="PFOS.openAddRecurringModal()" class="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold">+ Add Rule</button>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${rules.length ? rules.map(r => {
            const acc = state.accounts.find(a => a.id === r.accountId);
            return `
              <div class="p-4 rounded-xl bg-obsidian/70 border ${r.active ? 'border-slate-800' : 'border-slate-800/40 opacity-60'} flex flex-col justify-between gap-3">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${r.type === 'INCOME' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">${r.frequency}</span>
                      <span class="text-xs font-semibold text-slate-100">${escapeHtml(r.title)}</span>
                    </div>
                    <p class="text-[11px] text-slate-400 mt-1">Next: ${escapeHtml(r.nextRunDate)} · ${escapeHtml(acc ? acc.name : 'Account')}</p>
                  </div>
                  <span class="text-sm font-bold tabular-nums ${r.type === 'INCOME' ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(r.amount)}</span>
                </div>
                <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                  <div class="flex gap-1.5">
                    <button onclick="PFOS.runRecurringNow('${r.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 text-[11px] font-semibold">Run Now</button>
                    <button onclick="PFOS.toggleRecurringActive('${r.id}')" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-[11px] font-medium">${r.active ? 'Pause' : 'Resume'}</button>
                  </div>
                  <div class="flex gap-1">
                    <button onclick="PFOS.openEditRecurringModal('${r.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button onclick="PFOS.deleteRecurring('${r.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                  </div>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-xs text-slate-500 text-center py-8 col-span-2">No recurring rules configured.</p>'}
        </div>
      </div>
    `;
  }

  function renderBillsCalendarSubTab() {
    const obs = byProfile(state.obligations), billsSubs = obs.filter(o => o.kind !== 'EMI'), ccs = byProfile(state.accounts).filter(a => a.type === 'CREDIT_CARD');
    const year = calendarDate.getFullYear(), month = calendarDate.getMonth();
    const monthName = calendarDate.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    const firstDay = new Date(year, month, 1).getDay(), daysInMonth = new Date(year, month + 1, 0).getDate();

    const dayEvents = {};
    obs.forEach(o => { (dayEvents[o.dueDay] = dayEvents[o.dueDay] || []).push({ title: o.title, amount: o.amount, kind: o.kind, paid: o.paidThisMonth }); });
    ccs.forEach(c => { const d = c.dueDay || 5; (dayEvents[d] = dayEvents[d] || []).push({ title: `${c.name} Due`, amount: c.balance, kind: 'CARD', paid: c.balance <= 0 }); });

    let cells = '';
    for (let i = 0; i < firstDay; i++) cells += `<div class="h-10"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const hasEv = dayEvents[d] && dayEvents[d].length > 0, isSelected = d === selectedCalendarDay;
      cells += `<button onclick="PFOS.selectCalendarDay(${d})" class="h-10 rounded-lg flex flex-col items-center justify-center text-xs font-medium relative transition ${isSelected ? 'bg-emerald-500 text-slate-950 font-semibold' : hasEv ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'bg-obsidian/50 text-slate-300 hover:bg-slate-800'}"><span>${d}</span>${hasEv ? `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-slate-950' : 'bg-amber-400'} mt-0.5"></span>` : ''}</button>`;
    }
    const selEvents = dayEvents[selectedCalendarDay] || [];

    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${monthName}</h3><span class="text-[11px] text-slate-400">Due dates highlighted</span></div>
          <div class="grid grid-cols-7 gap-1.5 text-center text-[10px] font-semibold text-slate-500 mb-2"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
          <div class="grid grid-cols-7 gap-1.5">${cells}</div>
          <div class="mt-4 pt-3 border-t border-slate-800">
            <p class="text-xs font-semibold text-slate-300 mb-2">Scheduled for Day ${selectedCalendarDay}:</p>
            ${selEvents.length ? selEvents.map(ev => `<div class="flex items-center justify-between text-xs py-1.5"><span class="text-slate-200">${escapeHtml(ev.title)} <span class="text-[10px] text-slate-500">(${ev.kind})</span></span><span class="font-semibold tabular-nums ${ev.paid ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(ev.amount)}</span></div>`).join('') : '<p class="text-xs text-slate-500">No payments scheduled.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-3">
          <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Bills, Rent &amp; Subscriptions</h3><button onclick="PFOS.openAddObligationModal('BILL')" class="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-semibold">+ Add Bill</button></div>
          <div class="space-y-2">
            ${billsSubs.length ? billsSubs.map(b => `
              <div class="p-3 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><p class="text-xs font-semibold text-slate-100">${escapeHtml(b.title)}</p><p class="text-[11px] text-slate-400">${b.kind} · Day ${b.dueDay}</p></div>
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-semibold tabular-nums text-slate-200 mr-1">${formatINR(b.amount)}</span>
                  ${b.paidThisMonth ? '<span class="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 font-semibold">Paid</span>' : `<button onclick="PFOS.payObligation('${b.id}')" class="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 text-[11px] font-semibold">Pay</button>`}
                  <button onclick="PFOS.openEditObligationModal('${b.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteObligation('${b.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-500 text-center py-6">No bills or subscriptions added.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  function renderBudgetsGoalsSubTab() {
    const budgets = byProfile(state.budgets), goals = byProfile(state.goals), nowPrefix = todayISO().slice(0, 7);
    const monthExpenses = byProfile(state.transactions).filter(t => t.type === 'EXPENSE' && (t.date || '').startsWith(nowPrefix));
    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Monthly Budgets</h3><button onclick="PFOS.openAddBudgetModal()" class="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-semibold">+ Add Budget</button></div>
          <div class="space-y-3">
            ${budgets.length ? budgets.map(b => {
              const spent = monthExpenses.filter(t => (t.category || '').toLowerCase() === b.category.toLowerCase()).reduce((s, t) => s + Number(t.amount || 0), 0);
              const pct = Math.round((spent / Math.max(1, b.limit)) * 100);
              const bar = pct > 100 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-400' : 'bg-emerald-500';
              return `
                <div class="p-3 rounded-xl bg-obsidian/70 border border-slate-800">
                  <div class="flex justify-between items-center text-xs mb-1.5">
                    <span class="font-semibold text-slate-100">${escapeHtml(b.category)}</span>
                    <div class="flex items-center gap-1.5 tabular-nums">
                      <span class="text-slate-300"><strong>${formatINR(spent)}</strong> / ${formatINR(b.limit)}</span>
                      <button onclick="PFOS.openEditBudgetModal('${b.id}')" class="p-1 rounded text-slate-400 hover:text-sky-400"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                      <button onclick="PFOS.deleteBudget('${b.id}')" class="p-1 rounded text-slate-500 hover:text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>
                  <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden"><div class="h-full ${bar} rounded-full transition-all duration-700 ease-out" style="width:0%" data-bar-width="${Math.min(100, pct)}%"></div></div>
                </div>
              `;
            }).join('') : '<p class="text-xs text-slate-500 text-center py-6">No budgets set.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Savings Goals</h3><button onclick="PFOS.openAddGoalModal()" class="px-3 py-1.5 rounded-lg bg-sky-500/15 text-sky-300 text-xs font-semibold">+ Add Goal</button></div>
          <div class="space-y-3">
            ${goals.length ? goals.map(g => {
              const pct = Math.min(100, Math.round((g.saved / Math.max(1, g.target)) * 100));
              return `
                <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800">
                  <div class="flex justify-between items-start mb-1.5 gap-2">
                    <div><p class="text-xs font-semibold text-slate-100">${escapeHtml(g.title)}</p><p class="text-[11px] text-slate-400 tabular-nums">${formatINR(g.saved)} of ${formatINR(g.target)} (${pct}%)</p></div>
                    <div class="flex items-center gap-1">
                      <button onclick="PFOS.contributeGoal('${g.id}')" class="px-2 py-1 rounded-lg bg-sky-500/15 text-sky-300 text-[11px] font-semibold">+₹1k</button>
                      <button onclick="PFOS.openEditGoalModal('${g.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                      <button onclick="PFOS.deleteGoal('${g.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>
                  <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-sky-400 rounded-full transition-all duration-700 ease-out" style="width:0%" data-bar-width="${pct}%"></div></div>
                </div>
              `;
            }).join('') : '<p class="text-xs text-slate-500 text-center py-6">No goals created.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  function renderInvestmentsSubTab() {
    const invs = byProfile(state.investments);
    const totalInv = invs.reduce((s, i) => s + Number(i.invested || 0), 0);
    const totalCurr = invs.reduce((s, i) => s + Number(i.currentValue || 0), 0);
    const gain = totalCurr - totalInv, gainPct = totalInv > 0 ? ((gain / totalInv) * 100).toFixed(1) : '0.0';
    return `
      <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div><h3 class="text-sm font-semibold">Investments</h3><p class="text-xs text-slate-400 mt-0.5 tabular-nums">Invested: ${formatINR(totalInv)} · Current: <strong class="text-emerald-400">${formatINR(totalCurr)}</strong> (${gain >= 0 ? '+' : ''}${gainPct}%)</p></div>
          <button onclick="PFOS.openAddInvestmentModal()" class="px-3.5 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-semibold">+ Add Investment</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${invs.length ? invs.map(i => {
            const diff = i.currentValue - i.invested;
            return `
              <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><span class="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-emerald-300">${escapeHtml(i.assetType)}</span><p class="text-xs font-semibold text-slate-100 mt-1">${escapeHtml(i.name)}</p><p class="text-[11px] text-slate-400 tabular-nums">Invested: ${formatINR(i.invested)}</p></div>
                <div class="flex items-center gap-1.5">
                  <div class="text-right mr-1 tabular-nums"><p class="text-sm font-bold text-slate-100">${formatINR(i.currentValue)}</p><p class="text-[11px] font-medium ${diff >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${diff >= 0 ? '+' : ''}${formatINR(diff)}</p></div>
                  <button onclick="PFOS.openEditInvestmentModal('${i.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteInvestment('${i.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-xs text-slate-500 py-6 text-center col-span-2">No investments added.</p>'}
        </div>
      </div>
    `;
  }

  // ==================== TAB 5: REMINDERS (ONLY 2 REAL REMINDERS) ====================
  function renderRemindersTab() {
    const reminders = getActiveReminders();
    const ns = state.notificationSettings || defaultNotificationSettings();
    return `
      <div class="space-y-5 animate-fade-up">
        <div class="space-y-3">
          <h3 class="text-sm font-semibold">Active Reminders</h3>
          ${reminders.length ? reminders.map(r => `
            <div class="rounded-xl border ${r.severity === 'danger' ? 'border-rose-500/35 bg-rose-950/20' : r.severity === 'warning' ? 'border-amber-500/30 bg-amber-950/15' : 'border-slate-800 bg-card'} p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(r.tag)}</span>
                <h4 class="text-sm font-semibold text-slate-100 mt-0.5">${escapeHtml(r.title)}</h4>
                <p class="text-xs text-slate-300 mt-0.5">${escapeHtml(r.body)}</p>
              </div>
              <div class="flex flex-wrap gap-2 shrink-0">
                ${r.actions.map(act => `<button onclick="${act.onclick}" class="px-3 py-1.5 rounded-lg bg-obsidian hover:bg-slate-800 border border-slate-700 text-xs font-medium text-emerald-300 transition">${escapeHtml(act.label)}</button>`).join('')}
              </div>
            </div>
          `).join('') : '<div class="rounded-xl bg-card border border-slate-800 p-8 text-center text-xs text-slate-400">No active reminders for today.</div>'}
        </div>

        <form onsubmit="PFOS.saveNotificationSettings(event)" class="rounded-2xl bg-card border border-slate-800 p-5 space-y-4">
          <h3 class="text-sm font-semibold">Reminder Preferences</h3>
          <div class="space-y-3">
            <label class="flex items-center justify-between p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer">
              <div>
                <p class="text-xs font-semibold text-slate-200">End-of-Day Expense Review</p>
                <p class="text-[11px] text-slate-400">Reminds you once per day to verify all expenses are logged</p>
              </div>
              <input type="checkbox" name="dailyReviewEnabled" ${ns.dailyReviewEnabled ? 'checked' : ''} class="w-4 h-4 accent-emerald-500" />
            </label>

            <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-3">
              <div>
                <p class="text-xs font-semibold text-slate-200">Daily Review Time</p>
                <p class="text-[11px] text-slate-400">Preferred end-of-day time</p>
              </div>
              <input type="time" name="dailyReviewTime" value="${ns.dailyReviewTime || '21:00'}" class="bg-card border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100" />
            </div>

            <label class="flex items-center justify-between p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer">
              <div>
                <p class="text-xs font-semibold text-slate-200">Credit Card Due Reminders</p>
                <p class="text-[11px] text-slate-400">Alerts only for your actual cards with an unpaid balance due within 7 days</p>
              </div>
              <input type="checkbox" name="creditCardDueEnabled" ${ns.creditCardDueEnabled ? 'checked' : ''} class="w-4 h-4 accent-emerald-500" />
            </label>
          </div>
          <button type="submit" class="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition">Save Preferences</button>
        </form>
      </div>
    `;
  }

  // ==================== TAB 6: ANALYTICS ====================
  function renderAnalyticsTab() {
    const m = computeMetrics();
    return `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 animate-fade-up">
        <div class="rounded-xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Net Worth</p><p class="text-2xl font-bold text-emerald-400 tabular-nums mt-1" data-animate-value="${m.netWorth}" data-animate-mode="inr">${formatINR(m.netWorth)}</p></div>
        <div class="rounded-xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Monthly Income</p><p class="text-2xl font-bold text-sky-400 tabular-nums mt-1" data-animate-value="${m.monthlyIncome}" data-animate-mode="inr">${formatINR(m.monthlyIncome)}</p></div>
        <div class="rounded-xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Monthly Expenses</p><p class="text-2xl font-bold text-rose-400 tabular-nums mt-1" data-animate-value="${m.monthlyExpenses}" data-animate-mode="inr">${formatINR(m.monthlyExpenses)}</p></div>
      </div>
      <div class="rounded-2xl bg-card border border-slate-800 p-4 animate-fade-up stagger-1">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 class="text-sm font-semibold">Net Worth Trend</h3>
          <div class="flex gap-1.5">${['MONTHLY', 'QUARTERLY', 'YEARLY'].map(r => `<button onclick="PFOS.setAnalyticsRange('${r}')" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold ${analyticsRange === r ? 'bg-emerald-500 text-slate-950' : 'bg-obsidian text-slate-400'}">${r}</button>`).join('')}</div>
        </div>
        <div class="h-64 w-full"><canvas id="chart-networth"></canvas></div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-fade-up stagger-2">
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><h3 class="text-sm font-semibold mb-3">Assets vs. Liabilities</h3><div class="h-60 w-full"><canvas id="chart-assets-obs"></canvas></div></div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><h3 class="text-sm font-semibold mb-3">Expenses by Category</h3><div class="h-60 w-full"><canvas id="chart-categories"></canvas></div></div>
      </div>
    `;
  }

  function initAnalyticsCharts() {
    if (!window.Chart) return;
    const m = computeMetrics(), commonText = '#94a3b8', gridColor = 'rgba(148,163,184,0.08)';
    const animOpts = { duration: 850, easing: 'easeOutQuart' };

    const nwCanvas = document.getElementById('chart-networth');
    if (nwCanvas) {
      let labels = state.netWorthHistory.map(h => h.label), values = state.netWorthHistory.map(h => h.value);
      if (values.length) values[values.length - 1] = m.netWorth;
      if (analyticsRange === 'QUARTERLY') { labels = ['Q1', 'Q2', 'Q3', 'Q4']; values = [Math.round(m.netWorth * 0.62), Math.round(m.netWorth * 0.74), Math.round(m.netWorth * 0.89), m.netWorth]; }
      else if (analyticsRange === 'YEARLY') { labels = ['2024', '2025', '2026']; values = [Math.round(m.netWorth * 0.45), Math.round(m.netWorth * 0.76), m.netWorth]; }
      chartInstances.nw = new Chart(nwCanvas, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Net Worth (₹)', data: values, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', fill: true, tension: 0.35, pointBackgroundColor: '#10b981', pointRadius: 4 }] },
        options: { animation: animOpts, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: commonText }, grid: { color: gridColor } }, y: { ticks: { color: commonText }, grid: { color: gridColor } } } }
      });
    }
    const aoCanvas = document.getElementById('chart-assets-obs');
    if (aoCanvas) {
      chartInstances.ao = new Chart(aoCanvas, {
        type: 'bar',
        data: { labels: ['Banks', 'Cash', 'Wallets', 'Investments', 'Card Dues', 'EMIs/Bills', 'Borrowed'], datasets: [{ data: [m.bankBalance, m.cashBalance, m.walletBalance, m.investmentsValue, m.creditCardDues, m.upcomingEmis + m.upcomingBillsRent + m.upcomingSubs, m.borrowedDue], backgroundColor: ['#10b981', '#14b8a6', '#38bdf8', '#6366f1', '#f43f5e', '#f59e0b', '#fb7185'], borderRadius: 6 }] },
        options: { animation: animOpts, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: commonText, font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: commonText }, grid: { color: gridColor } } } }
      });
    }
    const catCanvas = document.getElementById('chart-categories');
    if (catCanvas) {
      const catMap = {};
      byProfile(state.transactions).filter(t => t.type === 'EXPENSE').forEach(t => { catMap[t.category || 'Other'] = (catMap[t.category || 'Other'] || 0) + Number(t.amount || 0); });
      const catLabels = Object.keys(catMap), catValues = Object.values(catMap);
      chartInstances.cat = new Chart(catCanvas, {
        type: 'doughnut',
        data: { labels: catLabels.length ? catLabels : ['No Expenses'], datasets: [{ data: catValues.length ? catValues : [1], backgroundColor: ['#10b981', '#f59e0b', '#f43f5e', '#38bdf8', '#a855f7', '#ec4899'], borderWidth: 0 }] },
        options: { animation: { animateRotate: true, animateScale: true, duration: 850, easing: 'easeOutQuart' }, responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#cbd5e1', boxWidth: 12, font: { size: 11 } } } } }
      });
    }
  }

  // ==================== TAB 7: SETTINGS & DATA ====================
  function renderSettingsTab() {
    const stats = PFOS_DB.getStats();
    return `
      <div class="space-y-4 animate-fade-up">
        <section class="rounded-2xl bg-card border border-slate-800 p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-semibold">Data Backup &amp; Restore</h3>
              <p class="text-xs text-slate-400 mt-0.5">All records are stored locally on your device (${stats.sizeKB} KB).</p>
            </div>
            <span class="text-[11px] font-medium px-2.5 py-1 rounded-full ${stats.encrypted ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-300'}">
              ${stats.encrypted ? 'PIN Protected' : 'Local Storage Active'}
            </span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button onclick="PFOS.exportSqliteFile()" class="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition">Export Database</button>
            <button onclick="document.getElementById('sqlite-import-input').click()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition">Import Database</button>
            <button onclick="PFOS.linkLocalSqliteFile()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition">${stats.diskLinked ? 'Disk Sync Active' : 'Auto-Save to Folder'}</button>
          </div>
        </section>

        <section class="rounded-2xl bg-card border border-slate-800 p-5 space-y-3">
          <div>
            <h3 class="text-sm font-semibold">App Security</h3>
            <p class="text-xs text-slate-400 mt-0.5">Protect your financial data with a local PIN.</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button onclick="PFOS.openSetEncryptionModal()" class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition">${stats.encrypted ? 'Change PIN' : 'Set PIN Lock'}</button>
            ${stats.encrypted ? `<button onclick="PFOS.lockVaultNow()" class="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-medium">Lock Now</button><button onclick="PFOS.disableEncryption()" class="px-4 py-2 rounded-xl bg-rose-500/15 text-rose-300 text-xs font-medium">Disable PIN</button>` : ''}
          </div>
        </section>

        <section class="rounded-2xl bg-card border border-slate-800 p-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold">Reset Data</h3>
            <p class="text-xs text-slate-400 mt-0.5">Clear all records to start fresh with your own finances.</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button onclick="PFOS.confirmReset('EMPTY')" class="px-4 py-2 rounded-xl bg-rose-500/15 border border-rose-500/25 text-rose-300 text-xs font-semibold">Start Fresh</button>
            <button onclick="PFOS.confirmReset('SAMPLE')" class="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-medium">Load Sample Data</button>
          </div>
        </section>
      </div>
    `;
  }

  // ==================== GLOBAL SEARCH ====================
  function openSearchModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold">Search</h3>
        <button onclick="PFOS.closeModal()" class="p-1 text-slate-400 hover:text-slate-200"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <input id="global-search-input" type="text" oninput="PFOS.runGlobalSearch(this.value)" placeholder="Search transactions, accounts, loans, bills..."
        class="w-full bg-obsidian border border-slate-700 focus:border-emerald-500 rounded-xl px-3.5 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none mb-3" />
      <div id="global-search-results" class="space-y-2 max-h-[55vh] overflow-y-auto text-xs text-slate-400">
        Type to search across all your records.
      </div>
    `);
    setTimeout(() => document.getElementById('global-search-input')?.focus(), 50);
  }

  function runGlobalSearch(rawQuery) {
    const box = document.getElementById('global-search-results');
    if (!box) return;
    const q = (rawQuery || '').trim().toLowerCase();
    if (!q) { box.innerHTML = '<p class="text-xs text-slate-500 py-4 text-center">Type a keyword to search.</p>'; return; }
    const hits = [];
    state.transactions.forEach(t => {
      if (`${t.merchant} ${t.category} ${t.method} ${t.notes} ${t.type} ${t.amount}`.toLowerCase().includes(q)) {
        hits.push({ tag: t.type, title: t.merchant || t.category, sub: `${t.date} · ${t.method}`, val: formatINR(t.amount), onclick: `PFOS.openEditTransactionModal('${t.id}')` });
      }
    });
    state.accounts.forEach(a => {
      if (`${a.name} ${a.bankName} ${a.type}`.toLowerCase().includes(q)) {
        hits.push({ tag: 'ACCOUNT', title: a.name, sub: a.bankName || a.type, val: formatINR(a.balance), onclick: `PFOS.openEditAccountModal('${a.id}')` });
      }
    });
    state.loans.forEach(l => {
      if (`${l.person} ${l.direction} ${l.notes}`.toLowerCase().includes(q)) {
        hits.push({ tag: 'LOAN', title: `${l.person} (${l.direction})`, sub: `Principal ${formatINR(l.principal)}`, val: formatINR(l.outstanding), onclick: `PFOS.openEditLoanModal('${l.id}')` });
      }
    });
    state.obligations.forEach(o => {
      if (`${o.title} ${o.kind}`.toLowerCase().includes(q)) {
        hits.push({ tag: o.kind, title: o.title, sub: `Due day ${o.dueDay}`, val: formatINR(o.amount), onclick: `PFOS.openEditObligationModal('${o.id}')` });
      }
    });
    box.innerHTML = hits.length
      ? hits.slice(0, 20).map(h => `
          <div onclick="${h.onclick}" class="cursor-pointer p-3 rounded-xl bg-obsidian hover:bg-slate-800 border border-slate-800 flex items-center justify-between gap-2 transition">
            <div class="min-w-0">
              <span class="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300 mr-1.5">${escapeHtml(h.tag)}</span>
              <span class="text-xs font-semibold text-slate-100">${escapeHtml(h.title)}</span>
              <p class="text-[11px] text-slate-400 mt-0.5 truncate">${escapeHtml(h.sub)}</p>
            </div>
            <span class="text-xs font-semibold text-slate-200 tabular-nums shrink-0">${escapeHtml(h.val)}</span>
          </div>
        `).join('')
      : '<p class="text-xs text-slate-500 py-6 text-center">No matches found.</p>';
  }

  // ==================== REMINDER SETTINGS ====================
  async function saveNotificationSettings(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.notificationSettings = {
      dailyReviewEnabled: fd.get('dailyReviewEnabled') === 'on',
      dailyReviewTime: fd.get('dailyReviewTime') || '21:00',
      creditCardDueEnabled: fd.get('creditCardDueEnabled') === 'on'
    };
    await persistState();
    renderCurrentView();
    showToast('Reminder preferences saved.');
  }

  // ==================== DATA & PIN HANDLERS ====================
  function exportSqliteFile() {
    const raw = PFOS_DB.exportRawSqlite();
    if (!raw) return showToast('Database not ready.', 'error');
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/x-sqlite3' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'pfos_backup.sqlite';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Database backup downloaded.');
  }

  function handleSqliteImport(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        state = ensureStateDefaults(await PFOS_DB.importRawSqlite(new Uint8Array(reader.result)));
        updateNavStyles();
        renderCurrentView();
        showToast('Database restored successfully.');
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
      e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
  }

  async function linkLocalSqliteFile() {
    try {
      const ok = await PFOS_DB.linkDiskFile();
      if (ok) { renderCurrentView(); showToast('Auto-save folder linked.'); }
      else { showToast('Exporting backup file instead.', 'info'); exportSqliteFile(); }
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Could not link folder: ' + err.message, 'error');
    }
  }

  function openSetEncryptionModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">Set App PIN</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <p class="text-xs text-slate-400 mb-3">Your local data will be encrypted using this PIN. Please remember it, as it cannot be recovered.</p>
      <form onsubmit="PFOS.saveEncryptionPin(event)" class="space-y-3">
        <input type="password" name="pin" required minlength="4" maxlength="12" inputmode="numeric" placeholder="Enter 4–12 digit PIN" class="w-full bg-obsidian border border-slate-700 rounded-xl px-4 py-3 text-center text-lg tracking-widest font-semibold text-slate-100" />
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Save PIN</button>
      </form>
    `);
  }

  async function saveEncryptionPin(e) {
    e.preventDefault();
    const pin = new FormData(e.target).get('pin');
    if (!pin || pin.length < 4) return showToast('PIN must be at least 4 digits.', 'warning');
    await PFOS_DB.enableEncryption(pin);
    closeModal(); updateNavStyles(); renderCurrentView();
    showToast('PIN protection enabled.');
  }

  async function disableEncryption() {
    await PFOS_DB.disableEncryption();
    updateNavStyles(); renderCurrentView();
    showToast('PIN protection disabled.', 'info');
  }

  async function lockVaultNow() {
    if (!PFOS_DB.getStats().encrypted) return;
    PFOS_DB.lockInMemory();
    state = null;
    const initRes = await PFOS_DB.init();
    if (initRes.locked) {
      pendingEncryptedBlob = initRes.encryptedBlob;
      document.getElementById('unlock-pin-input').value = '';
      document.getElementById('unlock-error').textContent = '';
      document.getElementById('unlock-gate').classList.remove('hidden');
      refreshIcons();
    }
  }

  async function handleUnlock(e) {
    e.preventDefault();
    const pin = document.getElementById('unlock-pin-input').value;
    try {
      await PFOS_DB.unlockWithPin(pendingEncryptedBlob, pin);
      pendingEncryptedBlob = null;
      document.getElementById('unlock-gate').classList.add('hidden');
      state = ensureStateDefaults(PFOS_DB.loadState());
      await processDueRecurringRules(true);
      document.getElementById('desktop-profile-select').value = state.activeProfile || 'ALL';
      document.getElementById('mobile-profile-select').value = state.activeProfile || 'ALL';
      updateNavStyles();
      renderCurrentView();
    } catch (_) {
      document.getElementById('unlock-error').textContent = 'Incorrect PIN. Please try again.';
    }
  }

  // ==================== CRUD MODALS ====================
  function openModal(html) { document.getElementById('modal-content').innerHTML = html; document.getElementById('modal-backdrop').classList.remove('hidden'); refreshIcons(); }
  function closeModal() { document.getElementById('modal-backdrop').classList.add('hidden'); }

  function applyBalanceImpact(tx, factor = 1) {
    const fromAcc = state.accounts.find(a => a.id === tx.accountId);
    const toAcc = tx.toAccountId ? state.accounts.find(a => a.id === tx.toAccountId) : null;
    const amt = Number(tx.amount || 0) * factor;
    if (tx.type === 'INCOME' && fromAcc) fromAcc.balance = Number(fromAcc.balance || 0) + amt;
    else if (tx.type === 'EXPENSE' && fromAcc) {
      if (fromAcc.type === 'CREDIT_CARD') fromAcc.balance = Math.max(0, Number(fromAcc.balance || 0) + amt);
      else fromAcc.balance = Number(fromAcc.balance || 0) - amt;
    } else if (tx.type === 'TRANSFER' && fromAcc && toAcc) {
      fromAcc.balance = Number(fromAcc.balance || 0) - amt;
      if (toAcc.type === 'CREDIT_CARD') toAcc.balance = Math.max(0, Number(toAcc.balance || 0) - amt);
      else toAcc.balance = Number(toAcc.balance || 0) + amt;
    }
  }

  function openTransactionModal(defaultType = 'EXPENSE', preselectAccId = '', editTx = null) {
    const type = editTx ? editTx.type : defaultType;
    const accounts = state.accounts.filter(a => a.type !== 'DEBIT_CARD');
    const categories = type === 'INCOME'
      ? ['Salary', 'Freelancing', 'Bonus', 'Refund', 'Interest', 'Gift', 'Other Income']
      : type === 'TRANSFER'
      ? ['ATM Withdrawal', 'Bank to Wallet', 'Wallet to Bank', 'Credit Card Bill', 'Self Transfer']
      : ['Food', 'Tea', 'Fuel', 'Shopping', 'Transport', 'Rent', 'EMI', 'Bills', 'Health', 'Entertainment', 'Other'];
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editTx ? 'Edit' : 'New'} ${type === 'TRANSFER' ? 'Transfer' : type.charAt(0) + type.slice(1).toLowerCase()}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      ${!editTx ? `
        <div class="grid grid-cols-3 gap-1.5 mb-4">
          <button type="button" onclick="PFOS.openTransactionModal('EXPENSE', '${preselectAccId}')" class="py-2 rounded-lg text-xs font-semibold border transition ${type === 'EXPENSE' ? 'bg-rose-500/15 border-rose-500/35 text-rose-300' : 'bg-obsidian border-slate-800 text-slate-400'}">Expense</button>
          <button type="button" onclick="PFOS.openTransactionModal('INCOME', '${preselectAccId}')" class="py-2 rounded-lg text-xs font-semibold border transition ${type === 'INCOME' ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300' : 'bg-obsidian border-slate-800 text-slate-400'}">Income</button>
          <button type="button" onclick="PFOS.openTransactionModal('TRANSFER', '${preselectAccId}')" class="py-2 rounded-lg text-xs font-semibold border transition ${type === 'TRANSFER' ? 'bg-sky-500/15 border-sky-500/35 text-sky-300' : 'bg-obsidian border-slate-800 text-slate-400'}">Transfer</button>
        </div>
      ` : ''}
      <form onsubmit="PFOS.submitTransaction(event, '${editTx ? editTx.id : ''}')" class="space-y-3">
        <input type="hidden" name="type" value="${type}" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Amount (₹)</label><input type="number" name="amount" required min="1" step="any" value="${editTx ? editTx.amount : ''}" placeholder="0" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-100 tabular-nums" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Date</label><input type="date" name="date" value="${editTx ? editTx.date : todayISO()}" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">${type === 'TRANSFER' ? 'From Account' : 'Account / Card'}</label>
            <select name="accountId" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              ${accounts.map(a => `<option value="${a.id}" ${(editTx ? editTx.accountId === a.id : a.id === preselectAccId && type !== 'TRANSFER') ? 'selected' : ''}>${escapeHtml(a.name)} (${formatINR(a.balance)})</option>`).join('')}
            </select>
          </div>
          ${type === 'TRANSFER' ? `
            <div><label class="text-[11px] text-slate-400 block mb-1">To Account</label><select name="toAccountId" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${accounts.map(a => `<option value="${a.id}" ${(editTx ? editTx.toAccountId === a.id : (a.id === preselectAccId || (!preselectAccId && a.type === 'CASH'))) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></div>
          ` : `
            <div><label class="text-[11px] text-slate-400 block mb-1">Category</label><select name="category" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${categories.map(c => `<option value="${c}" ${editTx && editTx.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          `}
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Merchant / Description</label><input type="text" name="merchant" value="${editTx ? escapeHtml(editTx.merchant) : ''}" placeholder="e.g. Grocery, Salary" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Method</label><select name="method" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['UPI','CASH','CARD','NETBANKING','AUTO'].map(m => `<option value="${m}" ${editTx && editTx.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Notes</label><input type="text" name="notes" value="${editTx ? escapeHtml(editTx.notes) : ''}" placeholder="Optional note" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Profile</label><select name="profile" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100">${['PERSONAL','FAMILY','BUSINESS'].map(p => `<option value="${p}" ${editTx && editTx.profile === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition">${editTx ? 'Update Transaction' : 'Save Transaction'}</button>
      </form>
    `);
  }

  function openEditTransactionModal(txId) { const tx = state.transactions.find(t => t.id === txId); if (tx) openTransactionModal(tx.type, '', tx); }
  async function addTransactionRecord(tx) {
    const toAcc = tx.toAccountId ? state.accounts.find(a => a.id === tx.toAccountId) : null;
    if (tx.type === 'TRANSFER' && toAcc && toAcc.type === 'CASH') tx.isAtm = true;
    applyBalanceImpact(tx, 1);
    state.transactions.unshift(tx);
    await persistState();
    renderCurrentView();
  }
  async function submitTransaction(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), type = fd.get('type'), amount = Number(fd.get('amount')), accountId = fd.get('accountId'), toAccountId = fd.get('toAccountId') || null;
    if (type === 'TRANSFER' && accountId === toAccountId) return showToast('Select two different accounts.', 'warning');
    if (editId) {
      const idx = state.transactions.findIndex(t => t.id === editId);
      if (idx === -1) return;
      const oldTx = state.transactions[idx];
      applyBalanceImpact(oldTx, -1);
      const toAcc = toAccountId ? state.accounts.find(a => a.id === toAccountId) : null;
      const updatedTx = { ...oldTx, profile: fd.get('profile') || 'PERSONAL', amount, accountId, toAccountId, category: fd.get('category') || oldTx.category, merchant: fd.get('merchant') || fd.get('category') || type, method: fd.get('method') || 'UPI', notes: fd.get('notes') || '', date: fd.get('date') || oldTx.date, isAtm: type === 'TRANSFER' && toAcc && toAcc.type === 'CASH' };
      applyBalanceImpact(updatedTx, 1);
      state.transactions[idx] = updatedTx;
      await persistState(); closeModal(); renderCurrentView(); showToast('Transaction updated.');
    } else {
      const now = new Date();
      await addTransactionRecord({ id: uid('tx'), profile: fd.get('profile') || 'PERSONAL', type, amount, accountId, toAccountId, category: fd.get('category') || (type === 'TRANSFER' ? 'Transfer' : 'Other'), merchant: fd.get('merchant') || fd.get('category') || type, method: fd.get('method') || 'UPI', notes: fd.get('notes') || '', date: fd.get('date') || todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'MANUAL' });
      closeModal(); showToast('Transaction saved.');
    }
  }
  async function deleteTransaction(txId) {
    const idx = state.transactions.findIndex(t => t.id === txId);
    if (idx === -1) return;
    applyBalanceImpact(state.transactions[idx], -1);
    state.transactions.splice(idx, 1);
    await persistState(); renderCurrentView(); showToast('Transaction deleted.', 'info');
  }

  // ==================== ENHANCED LOAN PAYMENT MODAL (AMOUNT + ACCOUNT + METHOD + DATE) ====================
  function openSettleLoanModal(loanId) {
    const l = state.loans.find(x => x.id === loanId);
    if (!l) return;
    const isLent = l.direction === 'LENT';
    const eligibleAccounts = state.accounts.filter(a => a.type !== 'DEBIT_CARD' && a.type !== 'CREDIT_CARD');

    openModal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-semibold">${isLent ? 'Record Payment Received' : 'Record Payment Paid'}</h3>
        <button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
      <div class="p-3 rounded-xl bg-obsidian/70 border border-slate-800 mb-3 flex items-center justify-between text-xs">
        <div>
          <p class="font-semibold text-slate-100">${escapeHtml(l.person)}</p>
          <p class="text-[11px] text-slate-400">${isLent ? 'Money Lent' : 'Money Borrowed'} · Principal ${formatINR(l.principal)}</p>
        </div>
        <div class="text-right tabular-nums">
          <p class="text-[10px] text-slate-400">Remaining</p>
          <p class="text-sm font-bold ${isLent ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(l.outstanding)}</p>
        </div>
      </div>

      <form onsubmit="PFOS.submitLoanPayment(event, '${loanId}')" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Amount ${isLent ? 'Received' : 'Paid'} (₹)</label>
            <input type="number" name="amount" required min="1" max="${l.outstanding}" step="any" value="${l.outstanding}"
              class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-100 tabular-nums" />
          </div>
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Date</label>
            <input type="date" name="date" required value="${todayISO()}"
              class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">${isLent ? 'Deposit Into Account' : 'Pay From Account'}</label>
            <select name="accountId" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              ${eligibleAccounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)} (${formatINR(a.balance)})</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Payment Method</label>
            <select name="method" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              <option value="UPI">UPI</option>
              <option value="CASH">Cash</option>
              <option value="NETBANKING">Bank Transfer</option>
              <option value="CARD">Card</option>
            </select>
          </div>
        </div>

        <div>
          <label class="text-[11px] text-slate-400 block mb-1">Notes (Optional)</label>
          <input type="text" name="notes" placeholder="e.g. Part payment via GPay" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" />
        </div>

        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition">
          Confirm ${isLent ? 'Receipt' : 'Payment'}
        </button>
      </form>
    `);
  }

  async function submitLoanPayment(e, loanId) {
    e.preventDefault();
    const l = state.loans.find(x => x.id === loanId);
    if (!l) return;
    const fd = new FormData(e.target);
    const amt = Number(fd.get('amount'));
    const accountId = fd.get('accountId');
    const method = fd.get('method') || 'UPI';
    const date = fd.get('date') || todayISO();
    const notes = fd.get('notes') || '';

    if (amt <= 0 || amt > l.outstanding) {
      return showToast('Enter a valid amount up to the outstanding balance.', 'warning');
    }

    const chosenAcc = state.accounts.find(a => a.id === accountId);
    if (!chosenAcc) return showToast('Please select a valid account.', 'error');

    // Update loan outstanding balance
    l.outstanding = Math.max(0, Number(l.outstanding) - amt);

    // Create linked transaction & automatically update chosen account balance
    const now = new Date();
    await addTransactionRecord({
      id: uid('tx'),
      profile: l.profile || 'PERSONAL',
      type: l.direction === 'LENT' ? 'INCOME' : 'EXPENSE',
      amount: amt,
      accountId: chosenAcc.id,
      toAccountId: null,
      category: 'Loan Settlement',
      merchant: `${l.direction === 'LENT' ? 'Received from' : 'Paid to'} ${l.person}`,
      method,
      date,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      source: 'MANUAL',
      notes
    });

    closeModal();
    showToast(`${l.direction === 'LENT' ? 'Received' : 'Paid'} ${formatINR(amt)} (${chosenAcc.name}).`);
  }

  // ==================== OTHER CRUD MODALS ====================
  function openAddAccountModal(editAcc = null) {
    const isCC = editAcc ? editAcc.type === 'CREDIT_CARD' : false;
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editAcc ? 'Edit Account' : 'Add Account'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitAccount(event, '${editAcc ? editAcc.id : ''}')" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Type</label><select name="type" onchange="document.getElementById('cc-extra-fields').classList.toggle('hidden', this.value !== 'CREDIT_CARD')" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${[['BANK','Bank Account'],['CASH','Cash'],['WALLET','Digital Wallet'],['CREDIT_CARD','Credit Card'],['DEBIT_CARD','Debit Card']].map(([v,l]) => `<option value="${v}" ${editAcc && editAcc.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Profile</label><select name="profile" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['PERSONAL','FAMILY','BUSINESS'].map(p => `<option value="${p}" ${editAcc && editAcc.profile===p?'selected':''}>${p}</option>`).join('')}</select></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Name</label><input type="text" name="name" required value="${editAcc ? escapeHtml(editAcc.name) : ''}" placeholder="e.g. HDFC Savings" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Bank / Provider</label><input type="text" name="bankName" value="${editAcc ? escapeHtml(editAcc.bankName) : ''}" placeholder="e.g. HDFC Bank" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Balance / Due (₹)</label><input type="number" name="balance" value="${editAcc ? editAcc.balance : 0}" step="any" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Last 4 Digits</label><input type="text" name="masked" maxlength="6" value="${editAcc ? escapeHtml(editAcc.masked) : ''}" placeholder="1234" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div id="cc-extra-fields" class="${isCC ? '' : 'hidden'} grid grid-cols-3 gap-2 pt-2 border-t border-slate-800">
          <div><label class="text-[10px] text-slate-400 block mb-1">Credit Limit</label><input type="number" name="creditLimit" value="${editAcc ? editAcc.creditLimit : 50000}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400 block mb-1">Stmt Day</label><input type="number" name="statementDay" value="${editAcc ? editAcc.statementDay : 15}" min="1" max="28" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400 block mb-1">Due Day</label><input type="number" name="dueDay" value="${editAcc ? editAcc.dueDay : 5}" min="1" max="28" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">${editAcc ? 'Update Account' : 'Save Account'}</button>
      </form>
    `);
  }
  function openEditAccountModal(id) { const a = state.accounts.find(x => x.id === id); if (a) openAddAccountModal(a); }
  async function submitAccount(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { profile: fd.get('profile'), type: fd.get('type'), name: fd.get('name'), bankName: fd.get('bankName'), masked: fd.get('masked'), balance: Number(fd.get('balance') || 0), creditLimit: Number(fd.get('creditLimit') || 0), statementDay: Number(fd.get('statementDay') || 15), dueDay: Number(fd.get('dueDay') || 5) };
    if (editId) { const i = state.accounts.findIndex(x => x.id === editId); if (i !== -1) state.accounts[i] = { ...state.accounts[i], ...payload }; showToast('Account updated.'); }
    else { state.accounts.push({ id: uid('acc'), ...payload }); showToast('Account added.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteAccount(id) {
    if (state.accounts.length <= 1) return showToast('At least one account is required.', 'warning');
    state.accounts = state.accounts.filter(a => a.id !== id);
    await persistState(); renderCurrentView(); showToast('Account removed.', 'info');
  }

  function openAddLoanModal(editLoan = null) {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editLoan ? 'Edit Loan' : 'Add Loan'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitLoan(event, '${editLoan ? editLoan.id : ''}')" class="space-y-3">
        <select name="direction" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100"><option value="LENT" ${editLoan && editLoan.direction==='LENT'?'selected':''}>Money Lent</option><option value="BORROWED" ${editLoan && editLoan.direction==='BORROWED'?'selected':''}>Money Borrowed</option></select>
        <input type="text" name="person" required value="${editLoan ? escapeHtml(editLoan.person) : ''}" placeholder="Person / Institution Name" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Principal (₹)</label><input type="number" name="principal" required min="1" value="${editLoan ? editLoan.principal : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Outstanding (₹)</label><input type="number" name="outstanding" min="0" value="${editLoan ? editLoan.outstanding : ''}" placeholder="Same as principal" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <input type="date" name="dueDate" value="${editLoan ? editLoan.dueDate : daysAgoISO(-30)}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">${editLoan ? 'Update Loan' : 'Save Loan'}</button>
      </form>
    `);
  }
  function openEditLoanModal(id) { const l = state.loans.find(x => x.id === id); if (l) openAddLoanModal(l); }
  async function submitLoan(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), principal = Number(fd.get('principal')), outVal = fd.get('outstanding'), outstanding = outVal !== '' ? Number(outVal) : principal;
    const payload = { direction: fd.get('direction'), person: fd.get('person'), principal, outstanding, dueDate: fd.get('dueDate') };
    if (editId) { const i = state.loans.findIndex(x => x.id === editId); if (i !== -1) state.loans[i] = { ...state.loans[i], ...payload }; showToast('Loan updated.'); }
    else { state.loans.push({ id: uid('ln'), profile: 'PERSONAL', ...payload }); showToast('Loan saved.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteLoan(id) { state.loans = state.loans.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Loan deleted.', 'info'); }

  function openAddRecurringModal(editRule = null) {
    const accounts = state.accounts.filter(a => a.type !== 'DEBIT_CARD');
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editRule ? 'Edit Recurring Rule' : 'Add Recurring Rule'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitRecurring(event, '${editRule ? editRule.id : ''}')" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Type</label><select name="type" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100"><option value="EXPENSE" ${editRule && editRule.type === 'EXPENSE' ? 'selected' : ''}>Expense</option><option value="INCOME" ${editRule && editRule.type === 'INCOME' ? 'selected' : ''}>Income</option></select></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Frequency</label><select name="frequency" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].map(f => `<option value="${f}" ${(editRule ? editRule.frequency : 'MONTHLY') === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
        </div>
        <input type="text" name="title" required value="${editRule ? escapeHtml(editRule.title) : ''}" placeholder="Title (e.g. Monthly Rent, Salary)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Amount (₹)</label><input type="number" name="amount" required min="1" step="any" value="${editRule ? editRule.amount : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Next Run Date</label><input type="date" name="nextRunDate" required value="${editRule ? editRule.nextRunDate : todayISO()}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Account</label><select name="accountId" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${accounts.map(a => `<option value="${a.id}" ${editRule && editRule.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Category</label><input type="text" name="category" value="${editRule ? escapeHtml(editRule.category) : 'Rent'}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">${editRule ? 'Update Rule' : 'Save Rule'}</button>
      </form>
    `);
  }
  function openEditRecurringModal(id) { const r = state.recurringRules.find(x => x.id === id); if (r) openAddRecurringModal(r); }
  async function submitRecurring(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { type: fd.get('type'), frequency: fd.get('frequency'), title: fd.get('title'), amount: Number(fd.get('amount')), nextRunDate: fd.get('nextRunDate'), accountId: fd.get('accountId'), category: fd.get('category') || 'Recurring', method: 'AUTO', active: true };
    if (editId) { const i = state.recurringRules.findIndex(x => x.id === editId); if (i !== -1) state.recurringRules[i] = { ...state.recurringRules[i], ...payload }; showToast('Recurring rule updated.'); }
    else { state.recurringRules.push({ id: uid('rec'), profile: 'PERSONAL', lastRunDate: '', ...payload }); showToast('Recurring rule added.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteRecurring(id) { state.recurringRules = state.recurringRules.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Rule deleted.', 'info'); }

  async function payObligation(obId) {
    const ob = state.obligations.find(o => o.id === obId); if (!ob || ob.paidThisMonth) return;
    const bank = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    ob.paidThisMonth = true;
    if (ob.kind === 'EMI' && ob.remainingMonths > 0) ob.remainingMonths -= 1;
    await addTransactionRecord({ id: uid('tx'), profile: ob.profile || 'PERSONAL', type: 'EXPENSE', amount: ob.amount, accountId: bank.id, category: ob.kind, merchant: ob.title, method: 'AUTO', date: todayISO(), time: '10:00', source: 'MANUAL' });
    showToast(`Paid ${ob.title} (${formatINR(ob.amount)})`);
  }
  function openAddObligationModal(defaultKind = 'BILL', editOb = null) {
    const kind = editOb ? editOb.kind : defaultKind;
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editOb ? 'Edit Obligation' : 'Add EMI / Bill / Subscription'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitObligation(event, '${editOb ? editOb.id : ''}')" class="space-y-3">
        <select name="kind" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['EMI','BILL','SUBSCRIPTION','RENT','INSURANCE'].map(k => `<option value="${k}" ${kind===k?'selected':''}>${k}</option>`).join('')}</select>
        <input type="text" name="title" required value="${editOb ? escapeHtml(editOb.title) : ''}" placeholder="Title" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <input type="number" name="amount" required min="1" value="${editOb ? editOb.amount : ''}" placeholder="Amount (₹)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
          <input type="number" name="dueDay" required min="1" max="28" value="${editOb ? editOb.dueDay : 10}" placeholder="Due Day (1-28)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <input type="number" name="remainingMonths" value="${editOb && editOb.remainingMonths != null ? editOb.remainingMonths : ''}" placeholder="Remaining Months (EMI)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
          <label class="flex items-center gap-2 text-xs text-slate-300 px-2"><input type="checkbox" name="paidThisMonth" ${editOb && editOb.paidThisMonth ? 'checked' : ''} /> Paid this month</label>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">${editOb ? 'Update' : 'Save'}</button>
      </form>
    `);
  }
  function openEditObligationModal(id) { const o = state.obligations.find(x => x.id === id); if (o) openAddObligationModal(o.kind, o); }
  async function submitObligation(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { kind: fd.get('kind'), title: fd.get('title'), amount: Number(fd.get('amount')), dueDay: Number(fd.get('dueDay')), remainingMonths: fd.get('remainingMonths') !== '' ? Number(fd.get('remainingMonths')) : null, frequency: 'MONTHLY', paidThisMonth: fd.get('paidThisMonth') === 'on' };
    if (editId) { const i = state.obligations.findIndex(x => x.id === editId); if (i !== -1) state.obligations[i] = { ...state.obligations[i], ...payload }; showToast('Updated.'); }
    else { state.obligations.push({ id: uid('ob'), profile: 'PERSONAL', ...payload }); showToast('Added.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteObligation(id) { state.obligations = state.obligations.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Deleted.', 'info'); }

  function openAddBudgetModal(editBg = null) {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editBg ? 'Edit Budget' : 'Add Budget'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitBudget(event, '${editBg ? editBg.id : ''}')" class="space-y-3">
        <input type="text" name="category" required value="${editBg ? escapeHtml(editBg.category) : ''}" placeholder="Category" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <input type="number" name="limit" required min="100" value="${editBg ? editBg.limit : ''}" placeholder="Monthly Limit (₹)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Save Budget</button>
      </form>
    `);
  }
  function openEditBudgetModal(id) { const b = state.budgets.find(x => x.id === id); if (b) openAddBudgetModal(b); }
  async function submitBudget(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { category: fd.get('category'), limit: Number(fd.get('limit')) };
    if (editId) { const i = state.budgets.findIndex(x => x.id === editId); if (i !== -1) state.budgets[i] = { ...state.budgets[i], ...payload }; showToast('Budget updated.'); }
    else { state.budgets.push({ id: uid('bg'), profile: 'PERSONAL', ...payload }); showToast('Budget saved.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteBudget(id) { state.budgets = state.budgets.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Budget deleted.', 'info'); }

  function openAddGoalModal(editGl = null) {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editGl ? 'Edit Goal' : 'Add Goal'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitGoal(event, '${editGl ? editGl.id : ''}')" class="space-y-3">
        <input type="text" name="title" required value="${editGl ? escapeHtml(editGl.title) : ''}" placeholder="Goal Title" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Target (₹)</label><input type="number" name="target" required min="100" value="${editGl ? editGl.target : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Saved (₹)</label><input type="number" name="saved" min="0" value="${editGl ? editGl.saved : 0}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Save Goal</button>
      </form>
    `);
  }
  function openEditGoalModal(id) { const g = state.goals.find(x => x.id === id); if (g) openAddGoalModal(g); }
  async function submitGoal(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { title: fd.get('title'), target: Number(fd.get('target')), saved: Number(fd.get('saved') || 0) };
    if (editId) { const i = state.goals.findIndex(x => x.id === editId); if (i !== -1) state.goals[i] = { ...state.goals[i], ...payload }; showToast('Goal updated.'); }
    else { state.goals.push({ id: uid('gl'), profile: 'PERSONAL', ...payload }); showToast('Goal saved.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function contributeGoal(id) { const g = state.goals.find(x => x.id === id); if (!g) return; g.saved = Math.min(g.target, Number(g.saved) + 1000); await persistState(); renderCurrentView(); showToast(`Added ₹1,000 toward ${g.title}`); }
  async function deleteGoal(id) { state.goals = state.goals.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Goal deleted.', 'info'); }

  function openAddInvestmentModal(editInv = null) {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">${editInv ? 'Edit Investment' : 'Add Investment'}</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <form onsubmit="PFOS.submitInvestment(event, '${editInv ? editInv.id : ''}')" class="space-y-3">
        <select name="assetType" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['SIP','MUTUAL_FUND','STOCK','GOLD','FD','RD','PPF','EPF','NPS'].map(t => `<option value="${t}" ${editInv && editInv.assetType===t?'selected':''}>${t}</option>`).join('')}</select>
        <input type="text" name="name" required value="${editInv ? escapeHtml(editInv.name) : ''}" placeholder="Asset Name" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Invested (₹)</label><input type="number" name="invested" required min="1" value="${editInv ? editInv.invested : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Current Value (₹)</label><input type="number" name="currentValue" required min="1" value="${editInv ? editInv.currentValue : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Save Investment</button>
      </form>
    `);
  }
  function openEditInvestmentModal(id) { const i = state.investments.find(x => x.id === id); if (i) openAddInvestmentModal(i); }
  async function submitInvestment(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { assetType: fd.get('assetType'), name: fd.get('name'), invested: Number(fd.get('invested')), currentValue: Number(fd.get('currentValue')), updated: todayISO() };
    if (editId) { const i = state.investments.findIndex(x => x.id === editId); if (i !== -1) state.investments[i] = { ...state.investments[i], ...payload }; showToast('Investment updated.'); }
    else { state.investments.push({ id: uid('inv'), profile: 'PERSONAL', ...payload }); showToast('Investment saved.'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteInvestment(id) { state.investments = state.investments.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Investment deleted.', 'info'); }

  // ==================== VOICE, SMS, HEALTH & RESET ====================
  function openVoiceModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">Voice Entry</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <p class="text-xs text-slate-400 mb-3">Example: "Spent 250 on lunch" or "Received 1500 cash from Rahul"</p>
      <button id="voice-mic-btn" onclick="PFOS.startSpeechRecognition()" class="w-full py-2.5 mb-3 rounded-xl bg-violet-500 text-slate-950 font-semibold text-xs">Tap to Speak</button>
      <textarea id="voice-input-text" rows="2" placeholder="Or type command..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogVoice()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Save Transaction</button>
    `);
  }
  function startSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return showToast('Voice input unavailable in this browser.', 'warning');
    const rec = new SpeechRec(); rec.lang = 'en-IN';
    const btn = document.getElementById('voice-mic-btn'); if (btn) btn.textContent = 'Listening...';
    rec.onresult = (ev) => { document.getElementById('voice-input-text').value = ev.results[0][0].transcript; if (btn) btn.textContent = 'Tap to Speak Again'; };
    rec.onerror = () => { if (btn) btn.textContent = 'Tap to Speak'; };
    rec.start();
  }
  async function parseAndLogVoice() {
    const text = (document.getElementById('voice-input-text')?.value || '').trim();
    const amtMatch = text.match(/(\d+(?:,\d+)*(?:\.\d{1,2})?)/);
    if (!amtMatch) return showToast('Could not detect an amount.', 'error');
    const amount = Number(amtMatch[1].replace(/,/g, '')), lower = text.toLowerCase();
    const bankAcc = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];
    let type = 'EXPENSE', accountId = cashAcc.id, toAccountId = null, category = 'Other', method = 'CASH';
    if (lower.includes('atm') || lower.includes('withdraw')) { type = 'TRANSFER'; accountId = bankAcc.id; toAccountId = cashAcc.id; category = 'ATM Withdrawal'; method = 'CARD'; }
    else if (lower.includes('received') || lower.includes('salary') || lower.includes('income')) { type = 'INCOME'; accountId = lower.includes('cash') ? cashAcc.id : bankAcc.id; category = 'Income'; method = lower.includes('cash') ? 'CASH' : 'UPI'; }
    else if (lower.includes('lunch') || lower.includes('tea') || lower.includes('food')) category = 'Food';
    else if (lower.includes('petrol') || lower.includes('fuel')) category = 'Fuel';
    const now = new Date();
    await addTransactionRecord({ id: uid('tx'), profile: 'PERSONAL', type, amount, accountId, toAccountId, category, merchant: text, method, date: todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'VOICE', isAtm: type === 'TRANSFER' });
    closeModal(); showToast('Transaction saved.');
  }

  function openSmsModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">Parse Bank SMS</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <textarea id="sms-raw-input" rows="3" placeholder="Paste bank or UPI transaction SMS..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogSms()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-semibold text-xs">Extract &amp; Save</button>
    `);
  }
  async function parseAndLogSms() {
    const raw = (document.getElementById('sms-raw-input')?.value || '').trim(), lower = raw.toLowerCase();
    if (lower.includes('otp')) return showToast('Ignored OTP message.', 'info');
    const amtMatch = raw.match(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    if (!amtMatch) return showToast('No amount detected in SMS.', 'error');
    const amount = Number(amtMatch[1].replace(/,/g, ''));
    const accDigits = raw.match(/(?:a\/c|acct|account|card)\s*(?:no\.?|ending)?\s*[x*]*(\d{4})/i)?.[1] || '';
    const vpa = raw.match(/([a-zA-Z0-9.\-_]+@[a-zA-Z]+)/)?.[1] || '';
    const isAtm = lower.includes('atm') || lower.includes('withdrawn'), isCredit = lower.includes('credited') || lower.includes('received');
    const matchedAcc = state.accounts.find(a => accDigits && a.masked === accDigits) || state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];
    const type = isAtm ? 'TRANSFER' : isCredit ? 'INCOME' : 'EXPENSE';
    const now = new Date();
    await addTransactionRecord({ id: uid('tx'), profile: matchedAcc.profile || 'PERSONAL', type, amount, accountId: matchedAcc.id, toAccountId: isAtm ? cashAcc.id : null, category: isAtm ? 'ATM Withdrawal' : isCredit ? 'Bank Credit' : 'UPI Spend', merchant: vpa ? vpa : matchedAcc.name, method: isAtm ? 'CARD' : 'UPI', upiId: vpa, date: todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'SMS', isAtm });
    closeModal(); showToast('Transaction extracted and saved.');
  }

  function openHealthBreakdownModal() {
    const m = computeMetrics(), b = m.healthBreakdown;
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-semibold">Health Score Breakdown</h3><button onclick="PFOS.closeModal()" class="p-1 text-slate-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
      <div class="text-center py-3 mb-4 rounded-xl bg-obsidian border border-slate-800"><span class="text-3xl font-bold text-emerald-400 tabular-nums">${m.healthScore}</span><span class="text-xs text-slate-500"> / 100</span></div>
      <div class="space-y-2 text-xs tabular-nums">
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Savings Rate (${b.savingsRate}%)</span><span class="font-semibold text-emerald-400">${b.savingsPts} / 25</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Credit Utilization (${Math.round(m.creditUtilization)}%)</span><span class="font-semibold text-emerald-400">${b.creditPts} / 20</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Emergency Reserve</span><span class="font-semibold text-amber-400">${b.emergencyPts} / 25</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Debt-to-Income Ratio</span><span class="font-semibold text-sky-400">${b.debtPts} / 15</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Payment Discipline</span><span class="font-semibold text-emerald-400">${b.disciplinePts} / 15</span></div>
      </div>
    `);
  }

  function confirmReset(mode) {
    openModal(`
      <h3 class="text-sm font-semibold mb-2">${mode === 'EMPTY' ? 'Start Fresh?' : 'Load Sample Data?'}</h3>
      <p class="text-xs text-slate-400 mb-5">This will replace your current records. Export a backup first if you want to keep your existing data.</p>
      <div class="flex gap-2">
        <button onclick="PFOS.closeModal()" class="flex-1 py-2.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-medium">Cancel</button>
        <button onclick="PFOS.executeReset('${mode}')" class="flex-1 py-2.5 rounded-xl bg-rose-500 text-white text-xs font-semibold">Confirm</button>
      </div>
    `);
  }
  async function executeReset(mode) {
    state = mode === 'EMPTY' ? getEmptyData() : getSampleData();
    await persistState(); closeModal(); updateNavStyles(); renderCurrentView();
    showToast(mode === 'EMPTY' ? 'Fresh profile created.' : 'Sample data loaded.');
  }

  function setTimelineType(t) { timelineFilter.type = t; renderCurrentView(); }
  function setTimelineAccount(id) { timelineFilter.accountId = id; renderCurrentView(); }
  function setTimelineSearch(q) { timelineFilter.search = q; renderCurrentView(); }
  function selectCalendarDay(d) { selectedCalendarDay = d; renderCurrentView(); }
  function setAnalyticsRange(r) { analyticsRange = r; renderCurrentView(); }

  function handleQuickAction(action) {
    if (!action) return;
    if (action === 'quick-expense') openTransactionModal('EXPENSE');
    else if (action === 'quick-income') openTransactionModal('INCOME');
    else if (action === 'quick-atm') openTransactionModal('TRANSFER');
    else if (action === 'voice') openVoiceModal();
    else if (action === 'search') openSearchModal();
  }

  // ==================== BOOTSTRAP ====================
  async function boot() {
    refreshIcons();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    try {
      const res = await PFOS_DB.init();
      if (res.locked) {
        pendingEncryptedBlob = res.encryptedBlob;
        document.getElementById('unlock-gate').classList.remove('hidden');
        refreshIcons();
        return;
      }
      if (res.isNew) {
        state = getSampleData();
        await PFOS_DB.saveState(state);
      } else {
        state = ensureStateDefaults(PFOS_DB.loadState());
      }
      await processDueRecurringRules(true);

      document.getElementById('desktop-profile-select').value = state.activeProfile || 'ALL';
      document.getElementById('mobile-profile-select').value = state.activeProfile || 'ALL';
      updateNavStyles();
      renderCurrentView();

      const params = new URLSearchParams(window.location.search);
      const urlAction = params.get('action');
      if (urlAction) {
        handleQuickAction(urlAction);
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (err) {
      document.getElementById('app-view').innerHTML = `
        <div class="rounded-xl bg-rose-950/50 border border-rose-500/40 p-6 text-center space-y-2">
          <h3 class="text-sm font-semibold text-rose-300">Unable to load local database</h3>
          <p class="text-xs text-slate-300">${escapeHtml(err.message)}</p>
          <button onclick="location.reload()" class="mt-2 px-4 py-2 rounded-lg bg-emerald-500 text-slate-950 text-xs font-semibold">Retry</button>
        </div>
      `;
    }
  }

  window.addEventListener('DOMContentLoaded', boot);

  return {
    setTab, setPlanningSubTab, switchProfile, closeModal, renderCurrentView,
    handleUnlock, openSetEncryptionModal, saveEncryptionPin, disableEncryption, lockVaultNow,
    openSearchModal, runGlobalSearch,
    processDueRecurringRules, runRecurringNow, toggleRecurringActive,
    openAddRecurringModal, openEditRecurringModal, submitRecurring, deleteRecurring,
    dismissReminderForToday, completeDailyReview, saveNotificationSettings,
    openTransactionModal, openEditTransactionModal, submitTransaction, deleteTransaction,
    openVoiceModal, startSpeechRecognition, parseAndLogVoice,
    openSmsModal, parseAndLogSms, openHealthBreakdownModal,
    openAddAccountModal, openEditAccountModal, submitAccount, deleteAccount,
    payObligation, openAddLoanModal, openEditLoanModal, submitLoan, deleteLoan, openSettleLoanModal, submitLoanPayment,
    openAddObligationModal, openEditObligationModal, submitObligation, deleteObligation,
    openAddBudgetModal, openEditBudgetModal, submitBudget, deleteBudget,
    openAddGoalModal, openEditGoalModal, submitGoal, contributeGoal, deleteGoal,
    openAddInvestmentModal, openEditInvestmentModal, submitInvestment, deleteInvestment,
    setTimelineType, setTimelineAccount, setTimelineSearch, selectCalendarDay, setAnalyticsRange,
    exportSqliteFile, handleSqliteImport, linkLocalSqliteFile,
    confirmReset, executeReset
  };
})();
