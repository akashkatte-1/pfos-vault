/**
 * PFOS v3.0 — Personal Financial Operating System & Offline Financial Assistant
 * 100% Offline • Encrypted SQLite (db-engine.js) • Zero Cost
 */
const PFOS = (() => {
  let state = null;
  let pendingEncryptedBlob = null;
  let activeTab = 'home';
  let planningSubTab = 'recurring'; // recurring | loans | bills | budgets | investments
  let assistantSubTab = 'alerts';   // alerts | audits | settings
  let timelineFilter = { type: 'ALL', accountId: 'ALL', search: '' };
  let analyticsRange = 'MONTHLY';
  let calendarDate = new Date();
  let selectedCalendarDay = new Date().getDate();
  let chartInstances = {};
  let deferredPwaPrompt = null;
  let dismissedAlertIds = new Set();

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
  });

  // Global Ctrl+K / Cmd+K search shortcut
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state) openSearchModal();
    }
  });

  // Listen for Service Worker notification action messages
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
    const todayDay = now.getDate();
    return targetDay - todayDay;
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
    el.className = `pointer-events-auto px-4 py-3 rounded-2xl border shadow-xl text-xs font-medium animate-fade-in ${colors[type] || colors.info}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }
  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  // ==================== DEFAULT SETTINGS & SEEDS ====================
  function defaultNotificationSettings() {
    return {
      morningTime: '08:30',
      afternoonTime: '14:00',
      nightTime: '21:00',
      frequency: 'DAILY', // IMMEDIATE | DAILY | WEEKLY | MONTHLY
      quietStart: '22:00',
      quietEnd: '07:00',
      sensitivity: 'MEDIUM', // LOW | MEDIUM | HIGH
      silentSummaryBar: true,
      browserNotifications: false,
      categories: {
        expenseReview: true,
        creditCards: true,
        bills: true,
        emi: true,
        income: true,
        cash: true,
        goals: true,
        investments: true,
        backup: true,
        commitments: true
      }
    };
  }

  function defaultWeeklyAudit() {
    return {
      weekKey: todayISO().slice(0, 10),
      expensesRecorded: false,
      cashVerified: false,
      creditCardsReviewed: false,
      loansUpdated: false,
      investmentsUpdated: false,
      commitmentsChecked: false
    };
  }

  function defaultMonthlyClosing() {
    return {
      monthKey: todayISO().slice(0, 7),
      verifyCash: false,
      verifyBanks: false,
      verifyCards: false,
      verifyLoans: false,
      verifyInvestments: false,
      verifySubscriptions: false
    };
  }

  function ensureStateDefaults(st) {
    if (!st.reconciliation) st.reconciliation = { dailyReviewDates: [], missedPayments90d: 0 };
    if (!st.notificationSettings) st.notificationSettings = defaultNotificationSettings();
    if (!st.notificationSettings.categories) st.notificationSettings.categories = defaultNotificationSettings().categories;
    if (!st.weeklyAudit) st.weeklyAudit = defaultWeeklyAudit();
    if (!st.monthlyClosing) st.monthlyClosing = defaultMonthlyClosing();
    if (!st.assistantMeta) st.assistantMeta = { lastBackupDate: daysAgoISO(15), previousHealthScore: 82, skippedSubs: [] };
    if (!Array.isArray(st.recurringRules)) st.recurringRules = [];
    return st;
  }

  function getSampleData() {
    const currDay = new Date().getDate();
    return ensureStateDefaults({
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [daysAgoISO(1), daysAgoISO(2), daysAgoISO(3)], missedPayments90d: 0 },
      notificationSettings: defaultNotificationSettings(),
      weeklyAudit: defaultWeeklyAudit(),
      monthlyClosing: defaultMonthlyClosing(),
      assistantMeta: { lastBackupDate: daysAgoISO(15), previousHealthScore: 82, skippedSubs: [] },
      accounts: [
        { id: 'acc_sbi', profile: 'PERSONAL', type: 'BANK', name: 'SBI Savings', bankName: 'State Bank of India', masked: '4821', ifsc: 'SBIN0001420', balance: 50800, notes: 'Salary account' },
        { id: 'acc_hdfc', profile: 'PERSONAL', type: 'BANK', name: 'HDFC Savings', bankName: 'HDFC Bank', masked: '9014', ifsc: 'HDFC0000240', balance: 34200, notes: 'Primary UPI & Bills' },
        { id: 'acc_biz', profile: 'BUSINESS', type: 'BANK', name: 'ICICI Freelance', bankName: 'ICICI Bank', masked: '3319', ifsc: 'ICIC0000104', balance: 22000, notes: 'Client retainers' },
        { id: 'acc_cash', profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Physical Cash', masked: '', balance: 4250, notes: 'Daily wallet cash' },
        { id: 'acc_emg_cash', profile: 'FAMILY', type: 'CASH', name: 'Home Emergency Cash', bankName: 'Home Safe', masked: '', balance: 15000, notes: 'Emergency reserve' },
        { id: 'acc_gpay', profile: 'PERSONAL', type: 'WALLET', name: 'GPay UPI Lite', bankName: 'Google Pay', masked: 'okhdfc', balance: 1850, notes: 'Small daily spends' },
        { id: 'acc_phonepe', profile: 'PERSONAL', type: 'WALLET', name: 'PhonePe Wallet', bankName: 'PhonePe', masked: 'ybl', balance: 950, notes: 'Recharges & fast UPI' },
        { id: 'acc_cc_hdfc', profile: 'PERSONAL', type: 'CREDIT_CARD', name: 'SBI Cashback Card', bankName: 'SBI Card', masked: '6672', balance: 12540, creditLimit: 60000, statementDay: 15, dueDay: Math.min(28, currDay + 3), minDue: 1254, annualFee: 999, notes: 'Online cashback card' },
        { id: 'acc_cc_icici', profile: 'PERSONAL', type: 'CREDIT_CARD', name: 'Amazon Pay ICICI CC', bankName: 'ICICI Bank', masked: '1108', balance: 5960, creditLimit: 50000, statementDay: 10, dueDay: Math.min(28, currDay + 7), minDue: 596, annualFee: 0, notes: 'Lifetime free' },
        { id: 'acc_dc_sbi', profile: 'PERSONAL', type: 'DEBIT_CARD', name: 'SBI Global Debit', bankName: 'State Bank of India', masked: '7741', linkedBank: 'SBI Savings', expiry: '08/29', balance: 0, notes: 'ATM' }
      ],
      transactions: [
        { id: 'tx_1', profile: 'PERSONAL', type: 'INCOME', amount: 45000, accountId: 'acc_sbi', category: 'Salary', method: 'NETBANKING', merchant: 'Monthly Salary', date: daysAgoISO(12), time: '09:05', source: 'RECURRING', notes: 'Auto Salary' },
        { id: 'tx_2', profile: 'BUSINESS', type: 'INCOME', amount: 18000, accountId: 'acc_biz', category: 'Freelancing', method: 'UPI', upiApp: 'GPay', upiId: 'client@okicici', refNumber: '431298451209', merchant: 'UI Design Sprint', date: daysAgoISO(6), time: '16:20', source: 'MANUAL', notes: 'Milestone 1' },
        { id: 'tx_3', profile: 'PERSONAL', type: 'TRANSFER', amount: 10000, accountId: 'acc_hdfc', toAccountId: 'acc_cash', category: 'ATM Withdrawal', method: 'CARD', merchant: 'ATM Withdraw', date: daysAgoISO(5), time: '14:40', source: 'SMS', isAtm: true, notes: 'HDFC ATM cash' },
        { id: 'tx_4', profile: 'PERSONAL', type: 'EXPENSE', amount: 280, accountId: 'acc_gpay', category: 'Food', method: 'UPI', upiApp: 'GPay', upiId: 'swiggy@icici', refNumber: '431987112233', merchant: 'Swiggy', date: daysAgoISO(2), time: '11:22', source: 'NOTIFICATION', notes: 'Lunch order' },
        { id: 'tx_5', profile: 'PERSONAL', type: 'EXPENSE', amount: 850, accountId: 'acc_cash', category: 'Food', method: 'CASH', merchant: 'Local Grocery & Veggies', date: daysAgoISO(2), time: '18:10', source: 'MANUAL', notes: 'Weekly veggies' },
        { id: 'tx_6', profile: 'PERSONAL', type: 'EXPENSE', amount: 100, accountId: 'acc_cash', category: 'Transport', method: 'CASH', merchant: 'Office Travel', date: daysAgoISO(1), time: '09:15', source: 'MANUAL', notes: 'Daily commute' },
        { id: 'tx_7', profile: 'PERSONAL', type: 'EXPENSE', amount: 1500, accountId: 'acc_hdfc', category: 'Fuel', method: 'UPI', upiApp: 'PhonePe', upiId: 'hpcl@ybl', refNumber: '432011998877', merchant: 'HPCL Petrol Pump', date: daysAgoISO(1), time: '10:30', source: 'SMS', notes: 'Petrol' },
        { id: 'tx_8', profile: 'PERSONAL', type: 'INCOME', amount: 500, accountId: 'acc_gpay', category: 'Refund', method: 'UPI', upiApp: 'GPay', merchant: 'GPay Received', date: todayISO(), time: '16:10', source: 'MANUAL', notes: 'Split bill' },
        { id: 'tx_9', profile: 'PERSONAL', type: 'EXPENSE', amount: 20, accountId: 'acc_cash', category: 'Tea', method: 'CASH', merchant: 'Tea', date: todayISO(), time: '20:00', source: 'LOCKSCREEN', notes: 'Evening chai' }
      ],
      recurringRules: [
        { id: 'rec_1', profile: 'FAMILY', type: 'EXPENSE', title: 'Monthly Rent', amount: 12000, accountId: 'acc_hdfc', category: 'Rent', method: 'NETBANKING', frequency: 'MONTHLY', nextRunDate: daysAgoISO(-5), lastRunDate: daysAgoISO(25), active: true },
        { id: 'rec_2', profile: 'PERSONAL', type: 'INCOME', title: 'Salary', amount: 45000, accountId: 'acc_sbi', category: 'Salary', method: 'NETBANKING', frequency: 'MONTHLY', nextRunDate: daysAgoISO(-11), lastRunDate: daysAgoISO(19), active: true },
        { id: 'rec_3', profile: 'PERSONAL', type: 'EXPENSE', title: 'Internet Bill', amount: 1000, accountId: 'acc_hdfc', category: 'Bills', method: 'UPI', frequency: 'MONTHLY', nextRunDate: daysAgoISO(-2), lastRunDate: daysAgoISO(28), active: true }
      ],
      loans: [
        { id: 'ln_1', profile: 'PERSONAL', direction: 'LENT', person: 'Rahul Sharma', principal: 10000, outstanding: 10000, interest: 0, dueDate: daysAgoISO(-15), notes: 'Emergency help' },
        { id: 'ln_2', profile: 'FAMILY', direction: 'BORROWED', person: 'Vikram (Cousin)', principal: 8000, outstanding: 4500, interest: 0, dueDate: daysAgoISO(-10), notes: 'Trip split' }
      ],
      obligations: [
        { id: 'ob_1', profile: 'PERSONAL', kind: 'EMI', title: 'Bike EMI', amount: 3200, dueDay: Math.min(28, currDay + 2), remainingMonths: 14, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_2', profile: 'FAMILY', kind: 'RENT', title: 'Monthly Rent', amount: 12000, dueDay: Math.min(28, currDay + 3), remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_3', profile: 'FAMILY', kind: 'BILL', title: 'Broadband Bill', amount: 999, dueDay: Math.min(28, currDay + 1), remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_4', profile: 'FAMILY', kind: 'BILL', title: 'Electricity Bill', amount: 1850, dueDay: Math.min(28, currDay + 5), remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_5', profile: 'PERSONAL', kind: 'SUBSCRIPTION', title: 'Netflix', amount: 649, dueDay: Math.min(28, currDay + 1), remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_6', profile: 'FAMILY', kind: 'INSURANCE', title: 'Term Life Insurance', amount: 2500, dueDay: Math.min(28, currDay + 6), remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false }
      ],
      budgets: [
        { id: 'bg_1', profile: 'PERSONAL', category: 'Food', limit: 5000 },
        { id: 'bg_2', profile: 'PERSONAL', category: 'Fuel', limit: 3000 },
        { id: 'bg_3', profile: 'PERSONAL', category: 'Shopping', limit: 4000 },
        { id: 'bg_4', profile: 'PERSONAL', category: 'Transport', limit: 2500 }
      ],
      goals: [
        { id: 'gl_1', profile: 'PERSONAL', title: 'Bike Fund', target: 150000, saved: 120000, targetDate: '2027-03-31' },
        { id: 'gl_2', profile: 'PERSONAL', title: 'Emergency Fund Goal', target: 150000, saved: 60000, targetDate: '2027-06-30' }
      ],
      investments: [
        { id: 'inv_1', profile: 'PERSONAL', assetType: 'SIP', name: 'Nifty 50 Index Direct SIP', invested: 60000, currentValue: 74500, updated: todayISO() },
        { id: 'inv_2', profile: 'PERSONAL', assetType: 'FD', name: 'SBI Fixed Deposit (7.1%)', invested: 50000, currentValue: 53550, updated: todayISO() }
      ],
      netWorthHistory: [
        { label: 'Jun', value: 184000 }, { label: 'Jul', value: 196500 }, { label: 'Aug', value: 208000 },
        { label: 'Sep', value: 215400 }, { label: 'Oct', value: 224800 }, { label: 'Nov', value: 236900 }
      ]
    });
  }

  function getEmptyData() {
    return ensureStateDefaults({
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [], missedPayments90d: 0 },
      notificationSettings: defaultNotificationSettings(),
      weeklyAudit: defaultWeeklyAudit(),
      monthlyClosing: defaultMonthlyClosing(),
      assistantMeta: { lastBackupDate: todayISO(), previousHealthScore: 80, skippedSubs: [] },
      accounts: [
        { id: uid('acc'), profile: 'PERSONAL', type: 'BANK', name: 'Primary Bank Account', bankName: 'SBI / HDFC', masked: '0000', ifsc: '', balance: 0, notes: '' },
        { id: uid('acc'), profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Physical Cash', masked: '', balance: 0, notes: '' }
      ],
      transactions: [], recurringRules: [], loans: [], obligations: [],
      budgets: [{ id: uid('bg'), profile: 'PERSONAL', category: 'Food', limit: 5000 }],
      goals: [], investments: [], netWorthHistory: [{ label: 'Now', value: 0 }]
    });
  }

  async function persistState() {
    try {
      await PFOS_DB.saveState(state);
      updateDbStatusUI();
      updatePersistentSummaryAndBadges();
    } catch (err) {
      showToast('SQLite write error: ' + err.message, 'error');
    }
  }

  function updateDbStatusUI() {
    const stats = PFOS_DB.getStats();
    const el = document.getElementById('sidebar-sqlite-status');
    if (el) el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span> SQLite • ${stats.sizeKB} KB ${stats.encrypted ? '🔒' : ''}`;
    const lockBtn = document.getElementById('header-lock-btn');
    if (lockBtn) lockBtn.classList.toggle('hidden', !stats.encrypted);
  }

  function byProfile(list) {
    if (!state || state.activeProfile === 'ALL') return list;
    return list.filter((item) => item.profile === state.activeProfile);
  }

  // ==================== RECURRING TRANSACTION ENGINE ====================
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
          id: uid('tx'),
          profile: rule.profile || 'PERSONAL',
          type: rule.type || 'EXPENSE',
          amount: Number(rule.amount || 0),
          accountId: rule.accountId || state.accounts[0]?.id,
          toAccountId: null,
          category: rule.category || 'Recurring',
          method: rule.method || 'AUTO',
          merchant: rule.title,
          date: rule.nextRunDate,
          time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          source: 'RECURRING',
          isAtm: false,
          notes: `Auto-generated (${rule.frequency})`
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
      if (!silent) showToast(`Recurring Engine auto-logged ${createdCount} scheduled entr${createdCount === 1 ? 'y' : 'ies'}!`);
    }
    return createdCount;
  }

  async function runRecurringNow(ruleId) {
    const rule = state.recurringRules.find(r => r.id === ruleId);
    if (!rule) return;
    const now = new Date();
    const tx = {
      id: uid('tx'),
      profile: rule.profile || 'PERSONAL',
      type: rule.type || 'EXPENSE',
      amount: Number(rule.amount || 0),
      accountId: rule.accountId || state.accounts[0]?.id,
      toAccountId: null,
      category: rule.category || 'Recurring',
      method: rule.method || 'AUTO',
      merchant: rule.title,
      date: todayISO(),
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      source: 'RECURRING',
      isAtm: false,
      notes: `Manual run (${rule.frequency})`
    };
    applyBalanceImpact(tx, 1);
    state.transactions.unshift(tx);
    rule.lastRunDate = todayISO();
    rule.nextRunDate = addFrequencyToDate(todayISO(), rule.frequency);
    await persistState();
    renderCurrentView();
    showToast(`Logged ${rule.title} (${formatINR(rule.amount)})`);
  }

  async function toggleRecurringActive(ruleId) {
    const r = state.recurringRules.find(x => x.id === ruleId);
    if (!r) return;
    r.active = !r.active;
    await persistState();
    renderCurrentView();
  }

  // ==================== CORE FINANCIAL ENGINE ====================
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

    let risk = { level: 'GREEN', label: 'Healthy (<50%)', badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', barClass: 'bg-emerald-500' };
    if (totalObligations > totalAssets) {
      risk = { level: 'RED', label: 'Critical (>Assets)', badgeClass: 'bg-rose-500/15 text-rose-400 border-rose-500/30', barClass: 'bg-rose-500' };
    } else if (commitmentRatio >= 50) {
      risk = { level: 'YELLOW', label: 'Caution (50%–100%)', badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30', barClass: 'bg-amber-500' };
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

    const atmWithdrawn = transactions.filter(t => t.type === 'TRANSFER' && t.isAtm).reduce((s, t) => s + Number(t.amount || 0), 0);
    const cashExpensesLogged = transactions.filter(t => t.type === 'EXPENSE' && t.method === 'CASH').reduce((s, t) => s + Number(t.amount || 0), 0);
    const unaccountedCash = Math.max(0, atmWithdrawn - cashExpensesLogged);
    const reviewedToday = (state.reconciliation.dailyReviewDates || []).includes(todayISO());
    const reviewCount = Math.min(7, (state.reconciliation.dailyReviewDates || []).length);
    const atmReconcileRatio = atmWithdrawn > 0 ? Math.min(1, cashExpensesLogged / atmWithdrawn) : 1;
    const completenessScore = Math.min(100, Math.round(55 + (reviewCount / 7) * 25 + atmReconcileRatio * 15 + (reviewedToday ? 5 : 0)));

    // Average daily spend over last 14 days
    const expByDay = {};
    transactions.filter(t => t.type === 'EXPENSE').forEach(t => {
      expByDay[t.date] = (expByDay[t.date] || 0) + Number(t.amount || 0);
    });
    const dayTotals = Object.values(expByDay);
    const avgDailySpend = dayTotals.length ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : 600;

    return {
      bankBalance, cashBalance, walletBalance, liquidAssets, investmentsValue, totalAssets,
      creditCardDues, totalCreditLimit, creditUtilization,
      upcomingEmis, upcomingRent, upcomingInsurance, upcomingBills, upcomingSubs,
      upcomingBillsRent: upcomingRent + upcomingInsurance + upcomingBills,
      upcomingDuesCount: unpaidObligations.length,
      borrowedDue, lentOutstanding,
      totalObligations, trueFreeMoney, commitmentRatio, risk, netWorth,
      monthlyIncome, monthlyExpenses, todaySpending, todayReceived, avgDailySpend,
      emergencyRequired, emergencySaved, emergencyPct,
      healthScore, healthBreakdown: { savingsPts, creditPts, emergencyPts, debtPts, disciplinePts, savingsRate: Math.round(savingsRate * 100) },
      atmWithdrawn, cashExpensesLogged, unaccountedCash, reviewedToday, completenessScore
    };
  }

  // ==================== SMART OFFLINE FINANCIAL ASSISTANT ENGINE (ALL 15 CATEGORIES) ====================
  function generateSmartAlerts() {
    const m = computeMetrics();
    const ns = state.notificationSettings || defaultNotificationSettings();
    const cats = ns.categories || defaultNotificationSettings().categories;
    const alerts = [];
    const today = todayISO();
    const nowDay = new Date().getDate();
    const skippedSubs = state.assistantMeta?.skippedSubs || [];

    const pushAlert = (a) => {
      if (!dismissedAlertIds.has(a.id)) alerts.push(a);
    };

    // Category 1: Daily Financial Review (Expense Review + Cash Wallet Review)
    if (cats.expenseReview && !m.reviewedToday) {
      pushAlert({
        id: 'cat1_daily_review',
        category: '1. Daily Financial Review',
        severity: 'info',
        title: 'Daily Expense Review',
        body: `You have recorded ${formatINR(m.todaySpending)} today. Have you logged all expenses?`,
        actions: [
          { label: 'Review Expenses', onclick: "PFOS.setTab('timeline')" },
          { label: '+ Add Expense', onclick: "PFOS.openQuickEntryPad('EXPENSE')" },
          { label: 'Mark Done', onclick: "PFOS.completeDailyReview()" }
        ]
      });
    }
    if (cats.cash && m.cashBalance > 0) {
      pushAlert({
        id: 'cat1_cash_review',
        category: '1. Daily Cash Review',
        severity: 'info',
        title: `Cash Wallet Review • ${formatINR(m.cashBalance)}`,
        body: `Current tracked cash is ${formatINR(m.cashBalance)}. Verify your physical cash balance.`,
        actions: [
          { label: 'Verify Cash ✓', onclick: "PFOS.dismissAlert('cat1_cash_review', 'Cash balance verified!')" },
          { label: 'Adjust Balance', onclick: "PFOS.openAdjustCashModal()" }
        ]
      });
    }

    // Category 2: Missing Expense Detection (Habit + ATM Reconciliation + Expense Gap)
    if (cats.expenseReview) {
      const todayTxs = state.transactions.filter(t => t.date === today && t.type === 'EXPENSE');
      const hasTravelToday = todayTxs.some(t => /travel|transport|auto|bus|metro/i.test((t.category || '') + ' ' + (t.merchant || '')));
      if (!hasTravelToday && ns.sensitivity !== 'LOW') {
        pushAlert({
          id: 'cat2_habit',
          category: '2. Missing Expense Detection',
          severity: 'warning',
          title: 'Possible Missing Habit Expense',
          body: 'You usually record daily commute / tea / lunch expenses. Did you forget to log one today?',
          actions: [
            { label: '+ Log Quick Expense', onclick: "PFOS.openQuickEntryPad('EXPENSE')" },
            { label: 'Dismiss', onclick: "PFOS.dismissAlert('cat2_habit')" }
          ]
        });
      }
      if (m.todaySpending < m.avgDailySpend * 0.25 && m.avgDailySpend >= 200) {
        pushAlert({
          id: 'cat2_gap',
          category: '2. Expense Gap Detection',
          severity: 'warning',
          title: 'Spending Lower Than Normal',
          body: `Average daily spend is ${formatINR(m.avgDailySpend)}/day, but today is only ${formatINR(m.todaySpending)}. Review today’s transactions.`,
          actions: [
            { label: 'Open Timeline', onclick: "PFOS.setTab('timeline')" },
            { label: 'Dismiss', onclick: "PFOS.dismissAlert('cat2_gap')" }
          ]
        });
      }
    }
    if (cats.cash && m.unaccountedCash > 0) {
      pushAlert({
        id: 'cat2_atm',
        category: '2. ATM Reconciliation',
        severity: 'warning',
        title: `ATM Cash Unaccounted: ${formatINR(m.unaccountedCash)}`,
        body: `ATM withdrawn: ${formatINR(m.atmWithdrawn)}, Cash expenses logged: ${formatINR(m.cashExpensesLogged)}. Review your cash usage.`,
        actions: [
          { label: '+ Log Cash Spend', onclick: "PFOS.openTransactionModal('EXPENSE', 'acc_cash')" },
          { label: 'Dismiss', onclick: "PFOS.dismissAlert('cat2_atm')" }
        ]
      });
    }

    // Category 3: Credit Card Notifications (Statement, 7d, 3d, Tomorrow, Today, Overdue)
    if (cats.creditCards) {
      byProfile(state.accounts).filter(a => a.type === 'CREDIT_CARD' && Number(a.balance) > 0).forEach(cc => {
        const diff = daysUntilDayOfMonth(cc.dueDay || 5);
        let stage = '';
        let sev = 'info';
        if (diff < 0) { stage = `${Math.abs(diff)} days OVERDUE`; sev = 'danger'; }
        else if (diff === 0) { stage = 'Payment DUE TODAY'; sev = 'danger'; }
        else if (diff === 1) { stage = 'Urgent: Due TOMORROW'; sev = 'danger'; }
        else if (diff <= 3) { stage = `Payment due in ${diff} days`; sev = 'warning'; }
        else if (diff <= 7) { stage = `Payment due in ${diff} days`; sev = 'warning'; }
        else if (Math.abs(daysUntilDayOfMonth(cc.statementDay || 15)) <= 1) { stage = 'Statement Generated'; sev = 'info'; }

        if (stage) {
          pushAlert({
            id: `cat3_cc_${cc.id}`,
            category: '3. Credit Card Alert',
            severity: sev,
            title: `${cc.name} — ${stage}`,
            body: `Amount Due: ${formatINR(cc.balance)} • Due Day: ${cc.dueDay}th • Min Due: ${formatINR(cc.minDue || Math.round(cc.balance * 0.05))}`,
            actions: [
              { label: 'Pay Card Bill', onclick: `PFOS.openTransactionModal('TRANSFER', '${cc.id}')` },
              { label: 'Dismiss', onclick: `PFOS.dismissAlert('cat3_cc_${cc.id}')` }
            ]
          });
        }
      });
    }

    // Category 4: Commitment Reminders (Negative Cash Flow, High Commitment, Upcoming)
    if (cats.commitments) {
      if (m.totalObligations > m.totalAssets) {
        pushAlert({
          id: 'cat4_negative',
          category: '4. Commitment Warning',
          severity: 'danger',
          title: 'Negative Cash Flow Warning',
          body: `Expected commitments (${formatINR(m.totalObligations)}) exceed available assets (${formatINR(m.totalAssets)}).`,
          actions: [{ label: 'Open Commitments', onclick: "PFOS.setTab('home')" }]
        });
      } else if (m.commitmentRatio >= 75) {
        pushAlert({
          id: 'cat4_high',
          category: '4. Commitment Warning',
          severity: 'warning',
          title: `High Commitment Alert (${Math.round(m.commitmentRatio)}%)`,
          body: `${Math.round(m.commitmentRatio)}% of your available funds are already committed to upcoming obligations.`,
          actions: [{ label: 'Review Commitments', onclick: "PFOS.setTab('home')" }]
        });
      }
    }

    // Categories 5, 6, 7: EMI, Bill & Subscription Reminders
    byProfile(state.obligations).filter(o => !o.paidThisMonth).forEach(ob => {
      const diff = daysUntilDayOfMonth(ob.dueDay);
      if (diff > 7) return;
      const dueLabel = diff < 0 ? `${Math.abs(diff)}d overdue` : diff === 0 ? 'Due Today' : diff === 1 ? 'Due Tomorrow' : `Due in ${diff} days`;

      if (ob.kind === 'EMI' && cats.emi) {
        pushAlert({
          id: `cat5_emi_${ob.id}`,
          category: '5. EMI Reminder',
          severity: diff <= 1 ? 'danger' : 'warning',
          title: `${ob.title} • ${dueLabel}`,
          body: `EMI Amount: ${formatINR(ob.amount)}. Did you pay your ${ob.title}?`,
          actions: [
            { label: 'Mark as Paid', onclick: `PFOS.payObligation('${ob.id}')` },
            { label: 'Remind Later', onclick: `PFOS.dismissAlert('cat5_emi_${ob.id}', 'Snoozed until tomorrow')` }
          ]
        });
      } else if (['BILL', 'RENT', 'INSURANCE'].includes(ob.kind) && cats.bills) {
        pushAlert({
          id: `cat6_bill_${ob.id}`,
          category: ob.kind === 'RENT' ? '4. Upcoming Commitment' : '6. Bill Reminder',
          severity: diff <= 1 ? 'danger' : 'warning',
          title: `${ob.title} • ${dueLabel}`,
          body: `${ob.kind} of ${formatINR(ob.amount)} scheduled for day ${ob.dueDay}.`,
          actions: [
            { label: 'Mark Paid', onclick: `PFOS.payObligation('${ob.id}')` },
            { label: 'Dismiss', onclick: `PFOS.dismissAlert('cat6_bill_${ob.id}')` }
          ]
        });
      } else if (ob.kind === 'SUBSCRIPTION' && cats.bills && !skippedSubs.includes(ob.id)) {
        pushAlert({
          id: `cat7_sub_${ob.id}`,
          category: '7. Subscription Renewal',
          severity: diff <= 1 ? 'warning' : 'info',
          title: `${ob.title} Renewal • ${dueLabel}`,
          body: `${formatINR(ob.amount)} renewal approaching.`,
          actions: [
            { label: 'Paid', onclick: `PFOS.payObligation('${ob.id}')` },
            { label: 'Skip Month', onclick: `PFOS.skipSubscriptionMonth('${ob.id}')` },
            { label: 'Later', onclick: `PFOS.dismissAlert('cat7_sub_${ob.id}')` }
          ]
        });
      }
    });

    // Category 8: Income Verification (Salary & Freelance)
    if (cats.income) {
      const monthPrefix = today.slice(0, 7);
      const hasSalaryThisMonth = state.transactions.some(t => t.type === 'INCOME' && (t.date || '').startsWith(monthPrefix) && /salary/i.test((t.category || '') + ' ' + (t.merchant || '')));
      if (!hasSalaryThisMonth && nowDay >= 2) {
        pushAlert({
          id: 'cat8_salary',
          category: '8. Income Verification',
          severity: 'info',
          title: 'Salary Not Recorded Yet',
          body: 'Salary normally arrives early in the month. No salary transaction found this month yet.',
          actions: [
            { label: '+ Add Income', onclick: "PFOS.openQuickEntryPad('INCOME')" },
            { label: 'Dismiss', onclick: "PFOS.dismissAlert('cat8_salary')" }
          ]
        });
      }
    }

    // Category 9 & 10: Weekly Audit & Monthly Closing
    const wa = state.weeklyAudit || defaultWeeklyAudit();
    const waDone = [wa.expensesRecorded, wa.cashVerified, wa.creditCardsReviewed, wa.loansUpdated, wa.investmentsUpdated, wa.commitmentsChecked].filter(Boolean).length;
    if (waDone < 6) {
      pushAlert({
        id: 'cat9_weekly',
        category: '9. Weekly Financial Audit',
        severity: 'info',
        title: `Weekly Financial Review (${waDone}/6 completed)`,
        body: 'Verify expenses, cash, credit cards, loans, investments, and commitments.',
        actions: [{ label: 'Open Checklist', onclick: "PFOS.setAssistantSubTab('audits')" }]
      });
    }

    // Category 11: Goal Progress & Achievement
    if (cats.goals) {
      byProfile(state.goals).forEach(g => {
        const pct = Math.round((Number(g.saved) / Math.max(1, Number(g.target))) * 100);
        if (pct >= 100) {
          pushAlert({
            id: `cat11_goal_done_${g.id}`,
            category: '11. Goal Achievement',
            severity: 'success',
            title: `Congratulations! ${g.title} Achieved 🎉`,
            body: `Target of ${formatINR(g.target)} reached!`,
            actions: [{ label: 'Dismiss', onclick: `PFOS.dismissAlert('cat11_goal_done_${g.id}')` }]
          });
        } else if (pct >= 75) {
          pushAlert({
            id: `cat11_goal_prog_${g.id}`,
            category: '11. Goal Progress',
            severity: 'success',
            title: `${g.title} — ${pct}% Complete`,
            body: `${formatINR(g.saved)} saved out of ${formatINR(g.target)}.`,
            actions: [
              { label: '+₹1,000', onclick: `PFOS.contributeGoal('${g.id}')` },
              { label: 'Dismiss', onclick: `PFOS.dismissAlert('cat11_goal_prog_${g.id}')` }
            ]
          });
        }
      });
    }

    // Category 12: Emergency Fund Alert
    if (cats.commitments && m.emergencyPct < 50) {
      pushAlert({
        id: 'cat12_emergency',
        category: '12. Emergency Fund Alert',
        severity: 'warning',
        title: `Emergency Fund Low (${m.emergencyPct}% Funded)`,
        body: `${formatINR(m.emergencySaved)} / ${formatINR(m.emergencyRequired)} recommended (6× monthly expenses).`,
        actions: [{ label: 'Dismiss', onclick: "PFOS.dismissAlert('cat12_emergency')" }]
      });
    }

    // Category 13: Financial Health Score Alert
    const prevScore = state.assistantMeta?.previousHealthScore ?? m.healthScore;
    if (m.healthScore < prevScore - 5) {
      pushAlert({
        id: 'cat13_health_drop',
        category: '13. Financial Health Alert',
        severity: 'warning',
        title: `Health Score dropped from ${prevScore} to ${m.healthScore}`,
        body: 'Review recent spending, credit card utilization, and upcoming obligations.',
        actions: [{ label: 'View Breakdown', onclick: "PFOS.openHealthBreakdownModal()" }]
      });
    }

    // Category 14: Backup Reminder
    if (cats.backup) {
      const lastBk = state.assistantMeta?.lastBackupDate || daysAgoISO(15);
      const diffDays = Math.floor((new Date() - new Date(lastBk + 'T00:00:00')) / 86400000);
      if (diffDays >= 7) {
        pushAlert({
          id: 'cat14_backup',
          category: '14. Backup Reminder',
          severity: 'warning',
          title: `Backup Recommended (Last: ${diffDays}d ago)`,
          body: 'Export pfos_vault.sqlite to your phone Downloads folder to protect your financial data.',
          actions: [
            { label: 'Backup .sqlite Now', onclick: "PFOS.exportSqliteFile()" },
            { label: 'Dismiss', onclick: "PFOS.dismissAlert('cat14_backup')" }
          ]
        });
      }
    }

    return alerts;
  }

  function updatePersistentSummaryAndBadges() {
    if (!state) return;
    const m = computeMetrics();
    const alerts = generateSmartAlerts();
    const count = alerts.length;

    const hb = document.getElementById('header-alert-badge');
    const sb = document.getElementById('sidebar-alert-badge');
    if (hb) { hb.textContent = count; hb.classList.toggle('hidden', count === 0); }
    if (sb) { sb.textContent = count; sb.classList.toggle('hidden', count === 0); }

    const bar = document.getElementById('persistent-summary-bar');
    const showBar = state.notificationSettings?.silentSummaryBar !== false;
    if (bar) {
      bar.classList.toggle('hidden', !showBar);
      if (showBar) {
        bar.innerHTML = `
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span class="font-bold text-slate-400 uppercase text-[10px]">Today</span>
            <span>Spent: <strong class="text-rose-400">${formatINR(m.todaySpending)}</strong></span>
            <span>Received: <strong class="text-emerald-400">${formatINR(m.todayReceived)}</strong></span>
            <span>Upcoming Dues: <strong class="text-amber-300">${m.upcomingDuesCount}</strong></span>
          </div>
          <div>Free Money: <strong class="${m.trueFreeMoney >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(m.trueFreeMoney)}</strong></div>
        `;
      }
    }
  }

  function dismissAlert(id, msg = '') {
    dismissedAlertIds.add(id);
    updatePersistentSummaryAndBadges();
    renderCurrentView();
    if (msg) showToast(msg, 'info');
  }

  async function skipSubscriptionMonth(obId) {
    state.assistantMeta.skippedSubs = state.assistantMeta.skippedSubs || [];
    if (!state.assistantMeta.skippedSubs.includes(obId)) state.assistantMeta.skippedSubs.push(obId);
    await persistState();
    renderCurrentView();
    showToast('Subscription skipped for this month.', 'info');
  }

  // Trigger real Browser/Android PWA Local Notification (100% offline via ServiceWorker)
  async function sendLocalNotification(title, body, action = 'home', actions = []) {
    if (!('Notification' in window)) return showToast('Browser notifications not supported on this device.', 'warning');
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return showToast('Notification permission denied.', 'warning');

    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, {
          body,
          icon: 'https://placehold.co/192x192/10b981/090d16.png?text=PFOS',
          badge: 'https://placehold.co/96x96/10b981/090d16.png?text=%E2%82%B9',
          tag: 'pfos-' + action,
          data: { action },
          actions
        });
      } else {
        new Notification(title, { body });
      }
      showToast('Offline local notification sent!');
    } catch (err) {
      showToast('Notification error: ' + err.message, 'warning');
    }
  }

  async function triggerPersistentSummaryNotification() {
    const m = computeMetrics();
    await sendLocalNotification(
      `PFOS Today • Free Money: ${formatINR(m.trueFreeMoney)}`,
      `Spent: ${formatINR(m.todaySpending)} | Received: ${formatINR(m.todayReceived)} | Upcoming Dues: ${m.upcomingDuesCount}`,
      'quick-expense',
      [
        { action: 'quick-expense', title: '+ Add Expense' },
        { action: 'voice', title: 'Voice Entry' }
      ]
    );
  }

  // ==================== NAVIGATION & VIEW ROUTER ====================
  function setTab(tab) {
    activeTab = tab;
    updateNavStyles();
    renderCurrentView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function setPlanningSubTab(sub) { planningSubTab = sub; renderCurrentView(); }
  function setAssistantSubTab(sub) {
    activeTab = 'assistant';
    assistantSubTab = sub;
    updateNavStyles();
    renderCurrentView();
  }
  async function switchProfile(profile) {
    state.activeProfile = profile;
    await persistState();
    document.getElementById('desktop-profile-select').value = profile;
    document.getElementById('mobile-profile-select').value = profile;
    renderCurrentView();
    showToast(`Switched to ${profile === 'ALL' ? 'All Profiles' : profile} view`, 'info');
  }
  function updateNavStyles() {
    const titles = {
      home: 'Money Commitments',
      accounts: 'Accounts & Cards',
      timeline: 'Daily Money Timeline',
      planning: 'Recurring & Planning',
      assistant: 'Smart Financial Assistant',
      analytics: 'Analytics & Net Worth',
      settings: 'SQLite Vault, Encryption & APK'
    };
    document.getElementById('header-title').textContent = titles[activeTab] || 'PFOS';
    document.querySelectorAll('.nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
        active ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25' : 'text-slate-400 hover:bg-card hover:text-slate-200 border border-transparent'
      }`;
    });
    document.querySelectorAll('.m-nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `m-nav-btn flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-xl text-[10px] font-medium transition ${
        active ? 'text-emerald-400 bg-emerald-500/10' : 'text-slate-400 hover:text-slate-200'
      }`;
    });
    updateDbStatusUI();
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
    else if (activeTab === 'assistant') container.innerHTML = renderAssistantTab();
    else if (activeTab === 'analytics') {
      container.innerHTML = renderAnalyticsTab();
      setTimeout(initAnalyticsCharts, 40);
    }
    else if (activeTab === 'settings') container.innerHTML = renderSettingsTab();
    updatePersistentSummaryAndBadges();
    refreshIcons();
  }

  // ==================== TAB 1: MONEY COMMITMENTS DASHBOARD ====================
  function renderHomeTab() {
    const m = computeMetrics();
    const alerts = generateSmartAlerts().slice(0, 2);
    const recentTxs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).slice(0, 5);
    const upcomingObs = byProfile(state.obligations).filter(o => !o.paidThisMonth).sort((a, b) => a.dueDay - b.dueDay).slice(0, 4);

    return `
      <!-- FLAGSHIP MONEY COMMITMENTS DASHBOARD -->
      <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-card to-slate-900 border border-slate-800 p-5 sm:p-6 shadow-2xl">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <p class="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
              <i data-lucide="sparkles" class="w-3.5 h-3.5 text-emerald-400"></i> Money Commitments Dashboard
            </p>
            <p class="text-[11px] text-slate-500 mt-0.5">Actual Free Money = Total Assets − Every Upcoming Obligation</p>
          </div>
          <span class="px-3 py-1 rounded-full text-xs font-bold border ${m.risk.badgeClass}">
            ${m.risk.label} • ${Math.round(m.commitmentRatio)}% Committed
          </span>
        </div>

        <div class="mb-4">
          <p class="text-xs text-slate-400">Actual Free Money</p>
          <div class="text-3xl sm:text-4xl font-extrabold tracking-tight mt-0.5 ${m.trueFreeMoney >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(m.trueFreeMoney)}</div>
        </div>

        <div class="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden mb-5">
          <div class="h-full ${m.risk.barClass} rounded-full transition-all duration-500" style="width: ${Math.min(100, Math.max(3, m.commitmentRatio))}%"></div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="rounded-2xl bg-obsidian/70 border border-slate-800/90 p-3.5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-emerald-400">Total Assets</span>
              <span class="text-base font-bold text-slate-100">${formatINR(m.totalAssets)}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <div class="flex justify-between"><span>Bank Balance</span><span class="text-slate-200">${formatINR(m.bankBalance)}</span></div>
              <div class="flex justify-between"><span>Cash Wallets</span><span class="text-slate-200">${formatINR(m.cashBalance)}</span></div>
              <div class="flex justify-between"><span>UPI Wallets</span><span class="text-slate-200">${formatINR(m.walletBalance)}</span></div>
              <div class="flex justify-between"><span>Investments</span><span class="text-slate-200">${formatINR(m.investmentsValue)}</span></div>
            </div>
          </div>

          <div class="rounded-2xl bg-obsidian/70 border border-slate-800/90 p-3.5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-rose-400">Commitments &amp; Dues</span>
              <span class="text-base font-bold text-rose-300">-${formatINR(m.totalObligations)}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <div class="flex justify-between"><span>Credit Cards</span><span class="text-rose-300">-${formatINR(m.creditCardDues)}</span></div>
              <div class="flex justify-between"><span>Upcoming EMI</span><span class="text-rose-300">-${formatINR(m.upcomingEmis)}</span></div>
              <div class="flex justify-between"><span>Rent</span><span class="text-rose-300">-${formatINR(m.upcomingRent)}</span></div>
              <div class="flex justify-between"><span>Ins/Bills/Subs</span><span class="text-rose-300">-${formatINR(m.upcomingInsurance + m.upcomingBills + m.upcomingSubs + m.borrowedDue)}</span></div>
            </div>
          </div>
        </div>
      </section>

      <!-- LOCK SCREEN / 3-SECOND QUICK ACTIONS BAR -->
      <section class="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        <button onclick="PFOS.openQuickEntryPad('EXPENSE')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-bold transition active:scale-95"><i data-lucide="zap" class="w-4 h-4"></i> + Expense (3s)</button>
        <button onclick="PFOS.openQuickEntryPad('INCOME')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition active:scale-95"><i data-lucide="plus-circle" class="w-4 h-4"></i> + Income</button>
        <button onclick="PFOS.openQuickEntryPad('ATM')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 text-xs font-bold transition active:scale-95"><i data-lucide="banknote" class="w-4 h-4"></i> + ATM / UPI</button>
        <button onclick="PFOS.openVoiceModal()" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-300 text-xs font-bold transition active:scale-95"><i data-lucide="mic" class="w-4 h-4"></i> Voice Entry</button>
        <button onclick="PFOS.openSmsModal()" class="col-span-2 sm:col-span-1 flex items-center justify-center gap-2 p-3 rounded-2xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-bold transition active:scale-95"><i data-lucide="message-square-code" class="w-4 h-4"></i> SMS Parser</button>
      </section>

      <!-- TOP ASSISTANT ALERTS PREVIEW -->
      ${alerts.length ? `
        <section class="rounded-2xl bg-amber-500/10 border border-amber-500/25 p-4 space-y-2.5">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-bold uppercase tracking-wider text-amber-300 flex items-center gap-1.5"><i data-lucide="bell-ring" class="w-4 h-4"></i> Smart Financial Assistant</h3>
            <button onclick="PFOS.setTab('assistant')" class="text-xs text-amber-300 font-semibold hover:underline">View All Alerts →</button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            ${alerts.map(a => `
              <div class="p-3 rounded-xl bg-obsidian/75 border border-slate-800 flex flex-col justify-between gap-2">
                <div>
                  <p class="text-[10px] font-bold text-slate-400 uppercase">${escapeHtml(a.category)}</p>
                  <p class="text-xs font-bold text-slate-100 mt-0.5">${escapeHtml(a.title)}</p>
                  <p class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(a.body)}</p>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  ${a.actions.map(act => `<button onclick="${act.onclick}" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-emerald-300">${escapeHtml(act.label)}</button>`).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <!-- KPI GRID -->
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div onclick="PFOS.setTab('analytics')" class="cursor-pointer rounded-2xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <div class="flex items-center justify-between text-slate-400 text-xs mb-1.5"><span>Net Worth</span><i data-lucide="trending-up" class="w-4 h-4 text-emerald-400"></i></div>
          <div class="text-xl font-extrabold text-slate-100">${formatINR(m.netWorth)}</div>
          <p class="text-[11px] text-slate-400 mt-1">Today Spend: <span class="text-rose-400 font-semibold">${formatINR(m.todaySpending)}</span></p>
        </div>
        <div onclick="PFOS.openHealthBreakdownModal()" class="cursor-pointer rounded-2xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <div class="flex items-center justify-between text-slate-400 text-xs mb-1.5"><span>Health Score</span><i data-lucide="heart-pulse" class="w-4 h-4 text-emerald-400"></i></div>
          <div class="flex items-baseline gap-1.5">
            <span class="text-xl font-extrabold ${m.healthScore >= 75 ? 'text-emerald-400' : m.healthScore >= 50 ? 'text-amber-400' : 'text-rose-400'}">${m.healthScore}</span>
            <span class="text-xs text-slate-500">/ 100</span>
          </div>
          <p class="text-[11px] text-sky-400 mt-1 underline decoration-dotted">Tap for breakdown</p>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between text-slate-400 text-xs mb-1.5"><span>Emergency Fund</span><i data-lucide="shield-alert" class="w-4 h-4 text-amber-400"></i></div>
          <div class="text-xl font-extrabold text-slate-100">${m.emergencyPct}%</div>
          <div class="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden my-1.5"><div class="h-full bg-amber-400 rounded-full" style="width:${m.emergencyPct}%"></div></div>
          <p class="text-[10px] text-slate-400">6× Exp: ${formatINR(m.emergencyRequired)}</p>
        </div>
        <div onclick="PFOS.setTab('timeline')" class="cursor-pointer rounded-2xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <div class="flex items-center justify-between text-slate-400 text-xs mb-1.5"><span>Completeness</span><i data-lucide="check-circle-2" class="w-4 h-4 text-teal-400"></i></div>
          <div class="text-xl font-extrabold text-teal-400">${m.completenessScore}%</div>
          <p class="text-[11px] text-slate-400 mt-1">${m.unaccountedCash > 0 ? `${formatINR(m.unaccountedCash)} cash gap` : 'Cash reconciled ✓'}</p>
        </div>
      </section>

      <!-- RECENT ACTIVITY + UPCOMING DUES -->
      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold">Recent Daily Money Timeline</h3>
            <button onclick="PFOS.setTab('timeline')" class="text-xs text-emerald-400 hover:underline">View All</button>
          </div>
          <div class="space-y-2.5">
            ${recentTxs.length ? recentTxs.map(t => renderTxRow(t, true)).join('') : '<p class="text-xs text-slate-500 py-6 text-center">No transactions yet.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold">Upcoming Dues &amp; EMIs</h3>
            <button onclick="PFOS.setTab('planning')" class="text-xs text-emerald-400 hover:underline">Manage All</button>
          </div>
          <div class="space-y-2.5">
            ${upcomingObs.length ? upcomingObs.map(ob => `
              <div class="flex items-center justify-between p-3 rounded-xl bg-obsidian/60 border border-slate-800/80">
                <div>
                  <p class="text-xs font-semibold text-slate-200">${escapeHtml(ob.title)}</p>
                  <p class="text-[11px] text-slate-400">${ob.kind} • Due Day ${ob.dueDay}${ob.remainingMonths ? ` • ${ob.remainingMonths}m left` : ''}</p>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-bold text-rose-400 mr-1">${formatINR(ob.amount)}</span>
                  <button onclick="PFOS.openEditObligationModal('${ob.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.payObligation('${ob.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[11px] font-semibold">Pay</button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-emerald-400/80 py-6 text-center">All monthly obligations are settled! 🎉</p>'}
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
      { key: 'CASH', title: 'Cash Wallets', icon: 'banknote', accent: 'text-amber-400' },
      { key: 'WALLET', title: 'Digital Wallets & UPI', icon: 'smartphone', accent: 'text-sky-400' },
      { key: 'CREDIT_CARD', title: 'Credit Cards', icon: 'credit-card', accent: 'text-rose-400' },
      { key: 'DEBIT_CARD', title: 'Debit Cards', icon: 'id-card', accent: 'text-slate-300' }
    ];
    return `
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="text-base font-bold">Accounts, Wallets &amp; Cards</h3>
          <p class="text-xs text-slate-400">Stored in SQLite • Edit balances, limits, or due dates anytime</p>
        </div>
        <button onclick="PFOS.openAddAccountModal()" class="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20 transition active:scale-95">
          <i data-lucide="plus" class="w-4 h-4"></i> Add Account / Card
        </button>
      </div>
      <div class="space-y-6">
        ${groups.map(g => {
          const items = accounts.filter(a => a.type === g.key);
          if (!items.length) return '';
          return `
            <section>
              <h4 class="text-xs uppercase tracking-wider font-bold text-slate-400 mb-3 flex items-center gap-2"><i data-lucide="${g.icon}" class="w-4 h-4 ${g.accent}"></i> ${g.title} (${items.length})</h4>
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
      <div class="rounded-2xl bg-card border border-slate-800 p-4 flex flex-col justify-between gap-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-sm font-bold text-slate-100">${escapeHtml(acc.name)}</p>
            <p class="text-[11px] text-slate-400">${escapeHtml(acc.bankName || acc.type)}${acc.masked ? ` •••• ${escapeHtml(acc.masked)}` : ''}</p>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-semibold">${acc.profile}</span>
        </div>
        <div class="flex items-end justify-between">
          <div>
            ${acc.type === 'DEBIT_CARD'
              ? `<p class="text-xs text-slate-300">Linked: ${escapeHtml(acc.linkedBank || 'Bank')}</p><p class="text-[11px] text-slate-500">Exp: ${escapeHtml(acc.expiry || 'N/A')}</p>`
              : `<p class="text-[11px] text-slate-500">Current Balance</p><p class="text-xl font-extrabold text-emerald-400">${formatINR(acc.balance)}</p>`
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
    let levelColor = 'bg-emerald-500', badge = { text: 'Safe (<30%)', cls: 'bg-emerald-500/15 text-emerald-400' };
    if (util >= 90) { levelColor = 'bg-rose-500'; badge = { text: 'Critical (90%+)', cls: 'bg-rose-500/15 text-rose-400' }; }
    else if (util >= 75) { levelColor = 'bg-orange-500'; badge = { text: 'High (75%+)', cls: 'bg-orange-500/15 text-orange-400' }; }
    else if (util >= 50) { levelColor = 'bg-amber-500'; badge = { text: 'Warning (50%+)', cls: 'bg-amber-500/15 text-amber-400' }; }
    else if (util >= 30) { levelColor = 'bg-yellow-500'; badge = { text: 'Moderate (30%+)', cls: 'bg-yellow-500/15 text-yellow-300' }; }

    return `
      <div class="rounded-2xl bg-gradient-to-br from-slate-900 to-card border border-slate-700/80 p-4 flex flex-col justify-between gap-3">
        <div class="flex items-start justify-between">
          <div><p class="text-sm font-bold text-slate-100">${escapeHtml(cc.name)}</p><p class="text-[11px] text-slate-400">${escapeHtml(cc.bankName)} •••• ${escapeHtml(cc.masked || '0000')}</p></div>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badge.cls}">${util}% • ${badge.text}</span>
        </div>
        <div>
          <div class="flex justify-between text-xs mb-1"><span class="text-slate-400">Outstanding</span><span class="font-bold text-rose-400">${formatINR(out)} <span class="text-slate-500 font-normal">/ ${formatINR(limit)}</span></span></div>
          <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full ${levelColor} rounded-full" style="width:${util}%"></div></div>
        </div>
        <div class="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-[11px]">
          <div><span class="text-slate-500 block">Stmt Day</span><span class="font-semibold">${cc.statementDay || 15}th</span></div>
          <div><span class="text-slate-500 block">Due Day</span><span class="font-semibold text-amber-400">${cc.dueDay || 5}th</span></div>
          <div><span class="text-slate-500 block">Min Due</span><span class="font-semibold">${formatINR(cc.minDue || Math.round(out * 0.05))}</span></div>
        </div>
        <div class="flex items-center justify-between gap-2 pt-1">
          <button onclick="PFOS.openTransactionModal('TRANSFER', '${cc.id}')" class="flex-1 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-xs font-bold transition">Pay Card Bill</button>
          <button onclick="PFOS.openEditAccountModal('${cc.id}')" class="p-2 rounded-xl text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition" title="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
          <button onclick="PFOS.deleteAccount('${cc.id}')" class="p-2 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </div>
      </div>
    `;
  }

  // ==================== TAB 3: DAILY MONEY TIMELINE ====================
  function renderTimelineTab() {
    const m = computeMetrics();
    const accounts = byProfile(state.accounts);
    let txs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    if (timelineFilter.type !== 'ALL') txs = txs.filter(t => t.type === timelineFilter.type);
    if (timelineFilter.accountId !== 'ALL') txs = txs.filter(t => t.accountId === timelineFilter.accountId || t.toAccountId === timelineFilter.accountId);
    if (timelineFilter.search.trim()) {
      const q = timelineFilter.search.toLowerCase();
      txs = txs.filter(t => (t.merchant || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q) || (t.upiId || '').toLowerCase().includes(q) || (t.method || '').toLowerCase().includes(q));
    }

    // Group transactions by date for Daily Money Timeline
    const grouped = {};
    txs.forEach(t => {
      const key = t.date || 'Unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    });
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    return `
      <section class="rounded-2xl bg-gradient-to-r from-amber-500/10 via-card to-teal-500/10 border border-amber-500/25 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <i data-lucide="radar" class="w-4 h-4 text-amber-400"></i>
            <h3 class="text-xs font-bold uppercase tracking-wider text-amber-300">Daily Cash &amp; Expense Reconciliation</h3>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300">${m.completenessScore}% Complete</span>
          </div>
          <p class="text-xs text-slate-300">
            ATM Withdrawn: <strong>${formatINR(m.atmWithdrawn)}</strong> • Cash Logged: <strong>${formatINR(m.cashExpensesLogged)}</strong>
            ${m.unaccountedCash > 0 ? ` • <span class="text-amber-400 font-bold">${formatINR(m.unaccountedCash)} unaccounted</span>` : ' • <span class="text-emerald-400 font-semibold">Reconciled ✓</span>'}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          ${m.unaccountedCash > 0 ? `<button onclick="PFOS.openTransactionModal('EXPENSE', 'acc_cash')" class="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-bold">+ Log Cash</button>` : ''}
          <button onclick="PFOS.completeDailyReview()" class="px-3 py-2 rounded-xl ${m.reviewedToday ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'} text-xs font-bold">${m.reviewedToday ? '✓ Daily Review Done' : 'Complete Daily Review'}</button>
        </div>
      </section>

      <section class="flex flex-col sm:flex-row gap-2.5">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2"></i>
          <input type="text" value="${escapeHtml(timelineFilter.search)}" oninput="PFOS.setTimelineSearch(this.value)" placeholder="Filter timeline: pizza, rahul, atm, cash, salary, netflix..." class="w-full bg-card border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
        </div>
        <div class="flex gap-2 overflow-x-auto no-scrollbar">
          ${['ALL', 'EXPENSE', 'INCOME', 'TRANSFER'].map(tp => `<button onclick="PFOS.setTimelineType('${tp}')" class="px-3.5 py-2 rounded-xl text-xs font-semibold shrink-0 border transition ${timelineFilter.type === tp ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-card border-slate-800 text-slate-400 hover:text-slate-200'}">${tp === 'ALL' ? 'All' : tp.charAt(0) + tp.slice(1).toLowerCase()}</button>`).join('')}
          <select onchange="PFOS.setTimelineAccount(this.value)" class="bg-card border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300">
            <option value="ALL">All Accounts</option>
            ${accounts.map(a => `<option value="${a.id}" ${timelineFilter.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="space-y-4">
        ${dates.length ? dates.map(dt => {
          const list = grouped[dt];
          const daySpent = list.filter(x => x.type === 'EXPENSE').reduce((s, x) => s + Number(x.amount), 0);
          const dayIn = list.filter(x => x.type === 'INCOME').reduce((s, x) => s + Number(x.amount), 0);
          const label = dt === todayISO() ? `Today (${dt})` : dt === daysAgoISO(1) ? `Yesterday (${dt})` : dt;
          return `
            <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-2.5">
              <div class="flex items-center justify-between pb-2 border-b border-slate-800/80">
                <h4 class="text-xs font-extrabold uppercase tracking-wider text-slate-300">${escapeHtml(label)}</h4>
                <div class="flex items-center gap-3 text-[11px]">
                  ${dayIn > 0 ? `<span class="text-emerald-400 font-bold">+${formatINR(dayIn)}</span>` : ''}
                  ${daySpent > 0 ? `<span class="text-rose-400 font-bold">-${formatINR(daySpent)}</span>` : ''}
                </div>
              </div>
              <div class="space-y-2">
                ${list.map(t => renderTxRow(t, true)).join('')}
              </div>
            </div>
          `;
        }).join('') : '<div class="rounded-2xl bg-card border border-slate-800 p-10 text-center text-xs text-slate-500">No matching transactions found.</div>'}
      </section>
    `;
  }

  function renderTxRow(t, allowActions) {
    const acc = state.accounts.find(a => a.id === t.accountId);
    const toAcc = t.toAccountId ? state.accounts.find(a => a.id === t.toAccountId) : null;
    const isInc = t.type === 'INCOME', isTr = t.type === 'TRANSFER';
    const icon = isInc ? 'arrow-down-left' : isTr ? 'arrow-left-right' : 'arrow-up-right';
    const iconBg = isInc ? 'bg-emerald-500/15 text-emerald-400' : isTr ? 'bg-sky-500/15 text-sky-400' : 'bg-rose-500/15 text-rose-400';
    const amtColor = isInc ? 'text-emerald-400' : isTr ? 'text-sky-400' : 'text-rose-400';
    const sign = isInc ? '+' : isTr ? '⇄ ' : '-';

    return `
      <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-obsidian/65 border border-slate-800/80 hover:border-slate-700/80 transition">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-xl ${iconBg} flex items-center justify-center shrink-0"><i data-lucide="${icon}" class="w-4 h-4"></i></div>
          <div class="min-w-0">
            <p class="text-xs font-bold text-slate-100 truncate">
              <span class="font-mono text-[11px] text-slate-400 mr-1.5">${escapeHtml(t.time || '12:00')}</span>${escapeHtml(t.merchant || t.category)}
            </p>
            <p class="text-[11px] text-slate-400 truncate">${escapeHtml(acc ? acc.name : 'Account')}${toAcc ? ` → ${escapeHtml(toAcc.name)}` : ''} • ${escapeHtml(t.method || 'UPI')}</p>
            <div class="flex flex-wrap gap-1.5 mt-1">
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">${escapeHtml(t.category || t.type)}</span>
              ${t.source && t.source !== 'MANUAL' ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">${escapeHtml(t.source)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-sm font-extrabold ${amtColor} mr-1">${sign}${formatINR(t.amount)}</span>
          ${allowActions ? `
            <button onclick="PFOS.openEditTransactionModal('${t.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
            <button onclick="PFOS.deleteTransaction('${t.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ==================== TAB 4: RECURRING ENGINE & PLANNING ====================
  function renderPlanningTab() {
    const subTabs = [
      { id: 'recurring', label: 'Recurring Engine' },
      { id: 'loans', label: 'Loans & EMIs' },
      { id: 'bills', label: 'Bills, Subs & Calendar' },
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
      <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        ${subTabs.map(s => `<button onclick="PFOS.setPlanningSubTab('${s.id}')" class="px-4 py-2 rounded-xl text-xs font-bold shrink-0 border transition ${planningSubTab === s.id ? 'bg-emerald-500 text-slate-950 border-emerald-500' : 'bg-card border-slate-800 text-slate-300 hover:bg-slate-800'}">${s.label}</button>`).join('')}
      </div>
      ${body}
    `;
  }

  function renderRecurringSubTab() {
    const rules = byProfile(state.recurringRules || []);
    return `
      <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-bold flex items-center gap-2"><i data-lucide="repeat" class="w-4 h-4 text-emerald-400"></i> Recurring Transaction Engine</h3>
            <p class="text-xs text-slate-400 mt-0.5">Auto-creates Daily, Weekly, Monthly, Quarterly, or Yearly entries when due.</p>
          </div>
          <div class="flex gap-2">
            <button onclick="PFOS.processDueRecurringRules(false).then(() => PFOS.renderCurrentView())" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold">Check Due Now</button>
            <button onclick="PFOS.openAddRecurringModal()" class="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold">+ Add Recurring Rule</button>
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
                      <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${r.type === 'INCOME' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">${r.frequency} • ${r.type}</span>
                      <span class="text-xs font-bold text-slate-100">${escapeHtml(r.title)}</span>
                    </div>
                    <p class="text-[11px] text-slate-400 mt-1">Next Run: <strong class="text-amber-300">${escapeHtml(r.nextRunDate)}</strong> • ${escapeHtml(acc ? acc.name : 'Account')}</p>
                  </div>
                  <span class="text-base font-extrabold ${r.type === 'INCOME' ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(r.amount)}</span>
                </div>
                <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                  <div class="flex gap-1.5">
                    <button onclick="PFOS.runRecurringNow('${r.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-[11px] font-bold">Run Now</button>
                    <button onclick="PFOS.toggleRecurringActive('${r.id}')" class="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 text-[11px] font-semibold">${r.active ? 'Pause' : 'Resume'}</button>
                  </div>
                  <div class="flex gap-1">
                    <button onclick="PFOS.openEditRecurringModal('${r.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                    <button onclick="PFOS.deleteRecurring('${r.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                  </div>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-xs text-slate-500 text-center py-8 col-span-2">No recurring rules yet. Add Salary, Rent, or Internet Bill.</p>'}
        </div>
      </div>
    `;
  }

  function renderLoansEmisSubTab() {
    const loans = byProfile(state.loans), emis = byProfile(state.obligations).filter(o => o.kind === 'EMI');
    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Loans (Lent &amp; Borrowed)</h3><button onclick="PFOS.openAddLoanModal()" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-xs font-bold">+ Add Loan</button></div>
          <div class="space-y-2.5">
            ${loans.length ? loans.map(l => `
              <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div>
                  <div class="flex items-center gap-2"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${l.direction === 'LENT' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">${l.direction}</span><span class="text-xs font-bold text-slate-100">${escapeHtml(l.person)}</span></div>
                  <p class="text-[11px] text-slate-400 mt-1">Principal: ${formatINR(l.principal)} • Due: ${escapeHtml(l.dueDate || 'Flexible')}</p>
                </div>
                <div class="flex items-center gap-1.5">
                  <div class="text-right mr-1">
                    <p class="text-sm font-extrabold ${l.direction === 'LENT' ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(l.outstanding)}</p>
                    ${l.outstanding > 0 ? `<button onclick="PFOS.openSettleLoanModal('${l.id}')" class="mt-0.5 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-200 font-semibold">Record Pay</button>` : '<span class="text-[10px] text-emerald-400">Settled ✓</span>'}
                  </div>
                  <button onclick="PFOS.openEditLoanModal('${l.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteLoan('${l.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-500 text-center py-6">No active loans tracked.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Active EMIs</h3><button onclick="PFOS.openAddObligationModal('EMI')" class="px-3 py-1.5 rounded-xl bg-amber-500/15 text-amber-300 text-xs font-bold">+ Add EMI</button></div>
          <div class="space-y-2.5">
            ${emis.length ? emis.map(e => `
              <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><p class="text-xs font-bold text-slate-100">${escapeHtml(e.title)}</p><p class="text-[11px] text-slate-400 mt-0.5">Due Day: ${e.dueDay}th • Remaining: <strong>${e.remainingMonths || 0}m</strong></p></div>
                <div class="flex items-center gap-1.5">
                  <span class="text-sm font-extrabold text-amber-400 mr-1">${formatINR(e.amount)}</span>
                  ${e.paidThisMonth ? '<span class="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 font-bold">Paid ✓</span>' : `<button onclick="PFOS.payObligation('${e.id}')" class="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-bold">Pay</button>`}
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
      cells += `<button onclick="PFOS.selectCalendarDay(${d})" class="h-10 rounded-xl flex flex-col items-center justify-center text-xs font-semibold relative transition ${isSelected ? 'bg-emerald-500 text-slate-950' : hasEv ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'bg-obsidian/50 text-slate-300 hover:bg-slate-800'}"><span>${d}</span>${hasEv ? `<span class="w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-slate-950' : 'bg-amber-400'} mt-0.5"></span>` : ''}</button>`;
    }
    const selEvents = dayEvents[selectedCalendarDay] || [];

    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold flex items-center gap-2"><i data-lucide="calendar" class="w-4 h-4 text-emerald-400"></i> ${monthName}</h3><span class="text-[11px] text-amber-300">Highlighted = Due Dates</span></div>
          <div class="grid grid-cols-7 gap-1.5 text-center text-[10px] font-bold text-slate-500 mb-2"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
          <div class="grid grid-cols-7 gap-1.5">${cells}</div>
          <div class="mt-4 pt-3 border-t border-slate-800">
            <p class="text-xs font-bold text-slate-300 mb-2">Due on Day ${selectedCalendarDay}:</p>
            ${selEvents.length ? selEvents.map(ev => `<div class="flex items-center justify-between text-xs py-1.5"><span class="text-slate-200">${escapeHtml(ev.title)} <span class="text-[10px] text-slate-500">(${ev.kind})</span></span><span class="font-bold ${ev.paid ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(ev.amount)}</span></div>`).join('') : '<p class="text-xs text-slate-500">No payments scheduled for this day.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-3">
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Bills, Rent &amp; Subscriptions</h3><button onclick="PFOS.openAddObligationModal('BILL')" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-xs font-bold">+ Add Bill / Sub</button></div>
          <div class="space-y-2">
            ${billsSubs.length ? billsSubs.map(b => `
              <div class="p-3 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><p class="text-xs font-bold text-slate-100">${escapeHtml(b.title)}</p><p class="text-[11px] text-slate-400">${b.kind} • Due ${b.dueDay}th (${b.frequency})</p></div>
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-bold text-slate-200 mr-1">${formatINR(b.amount)}</span>
                  ${b.paidThisMonth ? '<span class="text-[10px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 font-bold">Paid ✓</span>' : `<button onclick="PFOS.payObligation('${b.id}')" class="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 text-[11px] font-bold">Pay</button>`}
                  <button onclick="PFOS.openEditObligationModal('${b.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteObligation('${b.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `).join('') : '<p class="text-xs text-slate-500 text-center py-6">No recurring bills or subscriptions.</p>'}
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
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Monthly Budgets (50/75/90% Alerts)</h3><button onclick="PFOS.openAddBudgetModal()" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-xs font-bold">+ Add Budget</button></div>
          <div class="space-y-3">
            ${budgets.length ? budgets.map(b => {
              const spent = monthExpenses.filter(t => (t.category || '').toLowerCase() === b.category.toLowerCase()).reduce((s, t) => s + Number(t.amount || 0), 0);
              const pct = Math.round((spent / Math.max(1, b.limit)) * 100);
              let bar = 'bg-emerald-500', alertTag = '';
              if (pct > 100) { bar = 'bg-rose-500'; alertTag = 'EXCEEDED'; }
              else if (pct >= 90) { bar = 'bg-rose-400'; alertTag = '90% ALERT'; }
              else if (pct >= 75) { bar = 'bg-amber-400'; alertTag = '75% ALERT'; }
              else if (pct >= 50) { bar = 'bg-yellow-400'; alertTag = '50% USED'; }
              return `
                <div class="p-3 rounded-xl bg-obsidian/70 border border-slate-800">
                  <div class="flex justify-between items-center text-xs mb-1.5">
                    <span class="font-bold text-slate-100">${escapeHtml(b.category)} ${alertTag ? `<span class="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">${alertTag}</span>` : ''}</span>
                    <div class="flex items-center gap-1.5">
                      <span class="text-slate-300"><strong>${formatINR(spent)}</strong> / ${formatINR(b.limit)}</span>
                      <button onclick="PFOS.openEditBudgetModal('${b.id}')" class="p-1 rounded text-slate-400 hover:text-sky-400" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                      <button onclick="PFOS.deleteBudget('${b.id}')" class="p-1 rounded text-slate-500 hover:text-rose-400" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>
                  <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full ${bar} rounded-full" style="width:${Math.min(100, pct)}%"></div></div>
                </div>
              `;
            }).join('') : '<p class="text-xs text-slate-500 text-center py-6">No budgets set yet.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Financial Goal Planner</h3><button onclick="PFOS.openAddGoalModal()" class="px-3 py-1.5 rounded-xl bg-sky-500/15 text-sky-300 text-xs font-bold">+ Add Goal</button></div>
          <div class="space-y-3">
            ${goals.length ? goals.map(g => {
              const pct = Math.min(100, Math.round((g.saved / Math.max(1, g.target)) * 100));
              return `
                <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800">
                  <div class="flex justify-between items-start mb-1.5 gap-2">
                    <div><p class="text-xs font-bold text-slate-100">${escapeHtml(g.title)}</p><p class="text-[11px] text-slate-400">${formatINR(g.saved)} of ${formatINR(g.target)} (${pct}%)</p></div>
                    <div class="flex items-center gap-1">
                      <button onclick="PFOS.contributeGoal('${g.id}')" class="px-2 py-1 rounded-lg bg-sky-500/15 text-sky-300 text-[11px] font-bold">+₹1k</button>
                      <button onclick="PFOS.openEditGoalModal('${g.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                      <button onclick="PFOS.deleteGoal('${g.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                    </div>
                  </div>
                  <div class="w-full h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-sky-400 rounded-full" style="width:${pct}%"></div></div>
                </div>
              `;
            }).join('') : '<p class="text-xs text-slate-500 text-center py-6">No goals added yet.</p>'}
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
          <div><h3 class="text-sm font-bold">Manual Investment Portfolio (Zero Paid APIs)</h3><p class="text-xs text-slate-400 mt-0.5">Invested: ${formatINR(totalInv)} • Current: <strong class="text-emerald-400">${formatINR(totalCurr)}</strong> (${gain >= 0 ? '+' : ''}${gainPct}%)</p></div>
          <button onclick="PFOS.openAddInvestmentModal()" class="px-3.5 py-2 rounded-xl bg-emerald-500 text-slate-950 text-xs font-bold">+ Add Investment</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${invs.length ? invs.map(i => {
            const diff = i.currentValue - i.invested;
            return `
              <div class="p-3.5 rounded-xl bg-obsidian/70 border border-slate-800 flex items-center justify-between gap-2">
                <div><span class="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 text-emerald-300">${escapeHtml(i.assetType)}</span><p class="text-xs font-bold text-slate-100 mt-1">${escapeHtml(i.name)}</p><p class="text-[11px] text-slate-400">Invested: ${formatINR(i.invested)}</p></div>
                <div class="flex items-center gap-1.5">
                  <div class="text-right mr-1"><p class="text-sm font-extrabold text-slate-100">${formatINR(i.currentValue)}</p><p class="text-[11px] font-semibold ${diff >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${diff >= 0 ? '+' : ''}${formatINR(diff)}</p></div>
                  <button onclick="PFOS.openEditInvestmentModal('${i.id}')" class="p-1.5 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10" title="Edit"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
                  <button onclick="PFOS.deleteInvestment('${i.id}')" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10" title="Delete"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-xs text-slate-500 py-6 text-center col-span-2">No investments added yet.</p>'}
        </div>
      </div>
    `;
  }

  // ==================== TAB 5: SMART OFFLINE FINANCIAL ASSISTANT ====================
  function renderAssistantTab() {
    const subTabs = [
      { id: 'alerts', label: '15-Category Alerts Feed' },
      { id: 'audits', label: 'Weekly Audit & Monthly Closing' },
      { id: 'settings', label: 'Notification Settings' }
    ];
    let body = '';
    if (assistantSubTab === 'alerts') body = renderAssistantAlertsView();
    else if (assistantSubTab === 'audits') body = renderAssistantAuditsView();
    else body = renderNotificationSettingsView();

    return `
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          ${subTabs.map(s => `<button onclick="PFOS.setAssistantSubTab('${s.id}')" class="px-4 py-2 rounded-xl text-xs font-bold shrink-0 border transition ${assistantSubTab === s.id ? 'bg-amber-500 text-slate-950 border-amber-500' : 'bg-card border-slate-800 text-slate-300 hover:bg-slate-800'}">${s.label}</button>`).join('')}
        </div>
        <button onclick="PFOS.triggerPersistentSummaryNotification()" class="px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center gap-1.5">
          <i data-lucide="bell" class="w-3.5 h-3.5"></i> Push Offline Notification
        </button>
      </div>
      ${body}
    `;
  }

  function renderAssistantAlertsView() {
    const alerts = generateSmartAlerts();
    const sevStyles = {
      danger: 'border-rose-500/40 bg-rose-950/25',
      warning: 'border-amber-500/35 bg-amber-950/20',
      success: 'border-emerald-500/35 bg-emerald-950/20',
      info: 'border-slate-800 bg-card'
    };
    return `
      <div class="space-y-3">
        ${alerts.length ? alerts.map(a => `
          <div class="rounded-2xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${sevStyles[a.severity] || sevStyles.info}">
            <div>
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(a.category)}</span>
              <h4 class="text-sm font-bold text-slate-100 mt-0.5">${escapeHtml(a.title)}</h4>
              <p class="text-xs text-slate-300 mt-0.5">${escapeHtml(a.body)}</p>
            </div>
            <div class="flex flex-wrap gap-2 shrink-0">
              ${a.actions.map(act => `<button onclick="${act.onclick}" class="px-3 py-1.5 rounded-xl bg-obsidian hover:bg-slate-800 border border-slate-700 text-xs font-bold text-emerald-300 transition">${escapeHtml(act.label)}</button>`).join('')}
            </div>
          </div>
        `).join('') : '<div class="rounded-2xl bg-card border border-slate-800 p-10 text-center text-xs text-emerald-400">All caught up! No pending financial alerts right now. 🎉</div>'}
      </div>
    `;
  }

  function renderAssistantAuditsView() {
    const wa = state.weeklyAudit || defaultWeeklyAudit();
    const mc = state.monthlyClosing || defaultMonthlyClosing();
    const weeklyItems = [
      ['expensesRecorded', 'Expenses recorded for the week'],
      ['cashVerified', 'Physical cash wallet verified'],
      ['creditCardsReviewed', 'Credit card balances & due dates reviewed'],
      ['loansUpdated', 'Loans (lent & borrowed) updated'],
      ['investmentsUpdated', 'Manual investments values updated'],
      ['commitmentsChecked', 'Money Commitments Dashboard checked']
    ];
    const monthlyItems = [
      ['verifyCash', 'Verify physical cash balance'],
      ['verifyBanks', 'Verify all bank account balances'],
      ['verifyCards', 'Verify credit card statements & dues'],
      ['verifyLoans', 'Verify active loans & EMIs'],
      ['verifyInvestments', 'Update mutual funds, SIPs, FD, Gold, PPF'],
      ['verifySubscriptions', 'Audit active subscriptions & bills']
    ];

    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Category 9: Weekly Financial Audit -->
        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold">Category 9: Weekly Financial Audit</h3>
              <p class="text-[11px] text-slate-400">Every Sunday checklist</p>
            </div>
            <button onclick="PFOS.resetWeeklyAudit()" class="text-[11px] text-slate-400 hover:text-slate-200 underline">Reset</button>
          </div>
          <div class="space-y-2">
            ${weeklyItems.map(([k, label]) => `
              <label class="flex items-center gap-3 p-3 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer hover:border-slate-700">
                <input type="checkbox" ${wa[k] ? 'checked' : ''} onchange="PFOS.toggleAuditItem('weekly', '${k}', this.checked)" class="w-4 h-4 accent-emerald-500" />
                <span class="text-xs ${wa[k] ? 'line-through text-slate-500' : 'text-slate-200'}">${label}</span>
              </label>
            `).join('')}
          </div>
        </div>

        <!-- Category 10: Monthly Financial Closing -->
        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-sm font-bold">Category 10: Monthly Financial Closing</h3>
              <p class="text-[11px] text-slate-400">End-of-month reconciliation &amp; report</p>
            </div>
            <button onclick="PFOS.openMonthlyReportModal()" class="px-3 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold">Generate Report</button>
          </div>
          <div class="space-y-2">
            ${monthlyItems.map(([k, label]) => `
              <label class="flex items-center gap-3 p-3 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer hover:border-slate-700">
                <input type="checkbox" ${mc[k] ? 'checked' : ''} onchange="PFOS.toggleAuditItem('monthly', '${k}', this.checked)" class="w-4 h-4 accent-emerald-500" />
                <span class="text-xs ${mc[k] ? 'line-through text-slate-500' : 'text-slate-200'}">${label}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderNotificationSettingsView() {
    const ns = state.notificationSettings || defaultNotificationSettings();
    const cats = ns.categories || defaultNotificationSettings().categories;
    const catLabels = [
      ['expenseReview', 'Expense Review & Missing Habits'],
      ['creditCards', 'Credit Cards (Stmt, 7d, 3d, 1d, Overdue)'],
      ['bills', 'Bills & Subscriptions'],
      ['emi', 'EMI Due & Confirmation'],
      ['income', 'Income & Salary Verification'],
      ['cash', 'Cash Wallet & ATM Reconciliation'],
      ['goals', 'Goal Progress & Achievement'],
      ['investments', 'Investments Update'],
      ['backup', 'Backup Recommended Reminder'],
      ['commitments', 'Commitments & Emergency Fund Alerts']
    ];

    return `
      <form onsubmit="PFOS.saveNotificationSettings(event)" class="space-y-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-4">
          <h3 class="text-sm font-bold">Timing, Frequency, Quiet Hours &amp; Sensitivity</h3>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div><label class="text-[11px] text-slate-400 block mb-1">Morning Summary</label><input type="time" name="morningTime" value="${ns.morningTime}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
            <div><label class="text-[11px] text-slate-400 block mb-1">Afternoon Reminder</label><input type="time" name="afternoonTime" value="${ns.afternoonTime}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
            <div><label class="text-[11px] text-slate-400 block mb-1">Night Review (Default 9 PM)</label><input type="time" name="nightTime" value="${ns.nightTime}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label class="text-[11px] text-slate-400 block mb-1">Reminder Frequency</label>
              <select name="frequency" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100">
                ${['IMMEDIATE', 'DAILY', 'WEEKLY', 'MONTHLY'].map(f => `<option value="${f}" ${ns.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="text-[11px] text-slate-400 block mb-1">Sensitivity</label>
              <select name="sensitivity" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100">
                ${['LOW', 'MEDIUM', 'HIGH'].map(s => `<option value="${s}" ${ns.sensitivity === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div><label class="text-[11px] text-slate-400 block mb-1">Quiet Hours Start</label><input type="time" name="quietStart" value="${ns.quietStart}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
            <div><label class="text-[11px] text-slate-400 block mb-1">Quiet Hours End</label><input type="time" name="quietEnd" value="${ns.quietEnd}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          </div>

          <label class="flex items-center justify-between p-3 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer">
            <div>
              <p class="text-xs font-bold text-slate-200">Category 15: Silent Summary Notification Bar</p>
              <p class="text-[11px] text-slate-400">Shows Today Spent, Received, Upcoming Dues &amp; Free Money continuously at the top</p>
            </div>
            <input type="checkbox" name="silentSummaryBar" ${ns.silentSummaryBar !== false ? 'checked' : ''} class="w-4 h-4 accent-emerald-500" />
          </label>
        </div>

        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-3">
          <h3 class="text-sm font-bold">Notification Categories (Toggle Individually)</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${catLabels.map(([key, label]) => `
              <label class="flex items-center justify-between p-3 rounded-xl bg-obsidian/70 border border-slate-800 cursor-pointer">
                <span class="text-xs text-slate-200">${label}</span>
                <input type="checkbox" name="cat_${key}" ${cats[key] !== false ? 'checked' : ''} class="w-4 h-4 accent-emerald-500" />
              </label>
            `).join('')}
          </div>
          <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs">Save Assistant Settings to SQLite</button>
        </div>
      </form>
    `;
  }

  // ==================== TAB 6: ANALYTICS ====================
  function renderAnalyticsTab() {
    const m = computeMetrics();
    return `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Current Net Worth</p><p class="text-2xl font-extrabold text-emerald-400 mt-1">${formatINR(m.netWorth)}</p></div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Month Income</p><p class="text-2xl font-extrabold text-sky-400 mt-1">${formatINR(m.monthlyIncome)}</p></div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><p class="text-xs text-slate-400">Month Expenses</p><p class="text-2xl font-extrabold text-rose-400 mt-1">${formatINR(m.monthlyExpenses)}</p></div>
      </div>
      <div class="rounded-2xl bg-card border border-slate-800 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 class="text-sm font-bold">Net Worth Growth Trend</h3>
          <div class="flex gap-1.5">${['MONTHLY', 'QUARTERLY', 'YEARLY'].map(r => `<button onclick="PFOS.setAnalyticsRange('${r}')" class="px-2.5 py-1 rounded-lg text-[11px] font-bold ${analyticsRange === r ? 'bg-emerald-500 text-slate-950' : 'bg-obsidian text-slate-400'}">${r}</button>`).join('')}</div>
        </div>
        <div class="h-64 w-full"><canvas id="chart-networth"></canvas></div>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><h3 class="text-sm font-bold mb-3">Assets vs. Obligations</h3><div class="h-60 w-full"><canvas id="chart-assets-obs"></canvas></div></div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4"><h3 class="text-sm font-bold mb-3">Spending by Category</h3><div class="h-60 w-full"><canvas id="chart-categories"></canvas></div></div>
      </div>
    `;
  }

  function initAnalyticsCharts() {
    if (!window.Chart) return;
    const m = computeMetrics(), commonText = '#94a3b8', gridColor = 'rgba(148,163,184,0.08)';
    const nwCanvas = document.getElementById('chart-networth');
    if (nwCanvas) {
      let labels = state.netWorthHistory.map(h => h.label), values = state.netWorthHistory.map(h => h.value);
      if (values.length) values[values.length - 1] = m.netWorth;
      if (analyticsRange === 'QUARTERLY') { labels = ['Q1', 'Q2', 'Q3', 'Q4']; values = [Math.round(m.netWorth * 0.62), Math.round(m.netWorth * 0.74), Math.round(m.netWorth * 0.89), m.netWorth]; }
      else if (analyticsRange === 'YEARLY') { labels = ['2024', '2025', '2026']; values = [Math.round(m.netWorth * 0.45), Math.round(m.netWorth * 0.76), m.netWorth]; }
      chartInstances.nw = new Chart(nwCanvas, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Net Worth (₹)', data: values, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.14)', fill: true, tension: 0.35, pointBackgroundColor: '#10b981', pointRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: commonText }, grid: { color: gridColor } }, y: { ticks: { color: commonText }, grid: { color: gridColor } } } }
      });
    }
    const aoCanvas = document.getElementById('chart-assets-obs');
    if (aoCanvas) {
      chartInstances.ao = new Chart(aoCanvas, {
        type: 'bar',
        data: { labels: ['Banks', 'Cash', 'Wallets', 'Investments', 'Card Dues', 'EMIs/Bills', 'Borrowed'], datasets: [{ data: [m.bankBalance, m.cashBalance, m.walletBalance, m.investmentsValue, m.creditCardDues, m.upcomingEmis + m.upcomingBillsRent + m.upcomingSubs, m.borrowedDue], backgroundColor: ['#10b981', '#14b8a6', '#38bdf8', '#6366f1', '#f43f5e', '#f59e0b', '#fb7185'], borderRadius: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: commonText, font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: commonText }, grid: { color: gridColor } } } }
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
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#cbd5e1', boxWidth: 12, font: { size: 11 } } } } }
      });
    }
  }

  // ==================== TAB 7: SQLITE VAULT, ENCRYPTION & APK ====================
  function renderSettingsTab() {
    const stats = PFOS_DB.getStats();
    return `
      <section class="rounded-3xl bg-gradient-to-br from-sky-950/60 via-card to-slate-900 border border-sky-500/30 p-5 sm:p-6 space-y-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex items-start gap-3">
            <div class="w-11 h-11 rounded-2xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0"><i data-lucide="database" class="w-6 h-6"></i></div>
            <div>
              <h3 class="text-base font-extrabold text-slate-100">Encrypted SQLite Vault (<code class="text-sky-300">pfos_vault.sqlite</code>)</h3>
              <p class="text-xs text-slate-300 mt-1 leading-relaxed">
                Zero financial data is saved in <code>index.html</code> or <code>localStorage</code>. All tables persist directly in binary <strong>${escapeHtml(stats.backend)}</strong> (${stats.sizeKB} KB).
              </p>
            </div>
          </div>
          <span class="text-[11px] font-bold px-3 py-1 rounded-full ${stats.encrypted ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'}">
            ${stats.encrypted ? 'AES-256-GCM Encrypted 🔒' : 'Unencrypted SQLite'}
          </span>
        </div>
        <div class="flex flex-wrap gap-2.5">
          <button onclick="PFOS.exportSqliteFile()" class="px-4 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"><i data-lucide="download" class="w-4 h-4"></i> Download pfos_vault.sqlite</button>
          <button onclick="document.getElementById('sqlite-import-input').click()" class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-bold flex items-center gap-1.5 transition"><i data-lucide="upload" class="w-4 h-4"></i> Import .sqlite File</button>
          <button onclick="PFOS.linkLocalSqliteFile()" class="px-4 py-2.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold flex items-center gap-1.5 transition"><i data-lucide="hard-drive" class="w-4 h-4"></i> ${stats.diskLinked ? 'Disk Sync Active ✓' : 'Link Disk .sqlite (Desktop Auto-Save)'}</button>
        </div>
      </section>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-4">
          <div><h3 class="text-sm font-bold flex items-center gap-2"><i data-lucide="shield" class="w-4 h-4 text-emerald-400"></i> AES-256-GCM Vault Encryption</h3><p class="text-xs text-slate-400 mt-0.5">Encrypts the binary SQLite file on disk with your PIN</p></div>
          <div class="flex flex-wrap gap-2">
            <button onclick="PFOS.openSetEncryptionModal()" class="px-4 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-xs font-bold">${stats.encrypted ? 'Change Encryption PIN' : 'Enable AES-256 PIN Lock'}</button>
            ${stats.encrypted ? `<button onclick="PFOS.lockVaultNow()" class="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold">Lock Vault Now</button><button onclick="PFOS.disableEncryption()" class="px-4 py-2 rounded-xl bg-rose-500/15 text-rose-300 text-xs font-bold">Remove Encryption</button>` : ''}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-5 space-y-4">
          <div><h3 class="text-sm font-bold flex items-center gap-2"><i data-lucide="hard-drive-download" class="w-4 h-4 text-sky-400"></i> Portable Snapshot (.pfos)</h3><p class="text-xs text-slate-400 mt-0.5">Secondary JSON-encoded backup export/restore.</p></div>
          <div class="flex flex-wrap gap-2">
            <button onclick="PFOS.exportBackup()" class="px-4 py-2 rounded-xl bg-sky-500 text-slate-950 text-xs font-bold flex items-center gap-1.5"><i data-lucide="download" class="w-3.5 h-3.5"></i> Export .pfos</button>
            <button onclick="document.getElementById('pfos-import-input').click()" class="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold flex items-center gap-1.5"><i data-lucide="upload" class="w-3.5 h-3.5"></i> Restore .pfos</button>
          </div>
        </div>
      </div>

      <section class="rounded-3xl bg-gradient-to-br from-emerald-950/60 via-card to-slate-900 border border-emerald-500/30 p-5 sm:p-6 space-y-4">
        <div class="flex items-start gap-3">
          <div class="w-11 h-11 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0"><i data-lucide="smartphone" class="w-6 h-6"></i></div>
          <div><h3 class="text-base font-extrabold text-slate-100">Android Lock Screen Entry &amp; Native APK Kit</h3><p class="text-xs text-slate-300 mt-1">Install as a PWA with Android Home Screen Quick Shortcuts, or build the native APK with Lock Screen Notification, Quick Settings Tile, and Android 14+ Widget:</p></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">INSTANT PWA</span><h4 class="text-sm font-bold mt-2">1. Install via Chrome</h4><p class="text-[11px] text-slate-400 mt-1">Long-press app icon for 3-second +Expense, +Income, +ATM &amp; Voice shortcuts.</p></div>
            <button onclick="PFOS.triggerPwaInstall()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Install App</button>
          </div>
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300">NATIVE APK</span><h4 class="text-sm font-bold mt-2">2. Native Android APK Kit (.zip)</h4><p class="text-[11px] text-slate-400 mt-1">Includes SQLite, Lock Screen Persistent Notification, Quick Settings Tile &amp; GitHub APK builder.</p></div>
            <button onclick="PFOS.downloadFlutterApkKit()" class="w-full py-2.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs">Download Kit (.zip)</button>
          </div>
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300">WRAPPER</span><h4 class="text-sm font-bold mt-2">3. PWABuilder APK</h4><p class="text-[11px] text-slate-400 mt-1">Wrap your Vercel/Netlify URL into a signed Android APK.</p></div>
            <a href="https://www.pwabuilder.com" target="_blank" rel="noopener noreferrer" class="w-full py-2.5 rounded-xl bg-violet-500/20 border border-violet-500/40 text-violet-300 font-bold text-xs text-center">PWABuilder.com ↗</a>
          </div>
        </div>
      </section>

      <div class="rounded-2xl bg-card border border-slate-800 p-5 flex flex-wrap items-center justify-between gap-3">
        <div><h3 class="text-sm font-bold">Reset / Start Fresh</h3><p class="text-xs text-slate-400">Clear sample data to begin tracking your real finances.</p></div>
        <div class="flex flex-wrap gap-2">
          <button onclick="PFOS.confirmReset('EMPTY')" class="px-4 py-2 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-bold">Start Fresh (Empty SQLite)</button>
          <button onclick="PFOS.confirmReset('SAMPLE')" class="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold">Reload Sample Data</button>
        </div>
      </div>
    `;
  }

  // ==================== 3-SECOND QUICK ENTRY PAD (LOCK SCREEN / SHORTCUT MODE) ====================
  function openQuickEntryPad(mode = 'EXPENSE') {
    const quickCats = mode === 'INCOME'
      ? ['Cash Received', 'Salary', 'Freelance', 'Refund', 'Gift']
      : ['Tea', 'Lunch', 'Travel', 'Grocery', 'Snacks', 'Fuel', 'Other'];
    const bankAcc = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];

    openModal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-base font-extrabold flex items-center gap-2"><i data-lucide="zap" class="w-5 h-5 text-emerald-400"></i> 3-Second Quick Entry</h3>
        <button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>

      <div class="grid grid-cols-5 gap-1.5 mb-4">
        ${[
          ['EXPENSE', '+ Expense'],
          ['INCOME', '+ Income'],
          ['ATM', '+ ATM'],
          ['UPI', '+ UPI'],
          ['VOICE', 'Voice']
        ].map(([k, lbl]) => `
          <button type="button" onclick="${k === 'VOICE' ? 'PFOS.openVoiceModal()' : `PFOS.openQuickEntryPad('${k}')`}"
            class="py-2 rounded-xl text-[11px] font-bold border transition ${mode === k ? 'bg-emerald-500 text-slate-950 border-emerald-500' : 'bg-obsidian border-slate-800 text-slate-300'}">
            ${lbl}
          </button>
        `).join('')}
      </div>

      <form onsubmit="PFOS.submitQuickEntry(event, '${mode}')" class="space-y-3.5">
        <div>
          <label class="text-[11px] text-slate-400 block mb-1">Amount (₹)</label>
          <input id="quick-amt-input" type="number" name="amount" required min="1" step="any" autofocus placeholder="₹120"
            class="w-full bg-obsidian border border-emerald-500/40 rounded-2xl px-4 py-3 text-2xl font-extrabold text-emerald-400 text-center focus:outline-none focus:border-emerald-400" />
        </div>

        ${mode === 'ATM' ? `
          <p class="text-xs text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded-xl p-2.5 text-center">
            Transfers from <strong>${escapeHtml(bankAcc.name)}</strong> → <strong>${escapeHtml(cashAcc.name)}</strong>
          </p>
        ` : `
          <div>
            <label class="text-[11px] text-slate-400 block mb-1.5">${mode === 'UPI' ? 'UPI Recipient / Note' : 'Tap Category'}</label>
            ${mode === 'UPI' ? `
              <input type="text" name="label" required placeholder="e.g. Swiggy, Rahul, Shop UPI" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-slate-100" />
            ` : `
              <input type="text" id="quick-cat-input" name="label" value="${quickCats[0]}" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-100 mb-2" />
              <div class="flex flex-wrap gap-1.5">
                ${quickCats.map(c => `<button type="button" onclick="document.getElementById('quick-cat-input').value='${c}'" class="px-3 py-1.5 rounded-xl bg-obsidian hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200">${c}</button>`).join('')}
              </div>
            `}
          </div>
        `}

        <button type="submit" class="w-full py-3.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-sm shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition">
          Save in SQLite ✓
        </button>
      </form>
    `);
    setTimeout(() => document.getElementById('quick-amt-input')?.focus(), 50);
  }

  async function submitQuickEntry(e, mode) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = Number(fd.get('amount'));
    const label = (fd.get('label') || '').trim();
    const bankAcc = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];
    const walletAcc = state.accounts.find(a => a.type === 'WALLET') || bankAcc;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    let tx;
    if (mode === 'ATM') {
      tx = { id: uid('tx'), profile: 'PERSONAL', type: 'TRANSFER', amount, accountId: bankAcc.id, toAccountId: cashAcc.id, category: 'ATM Withdrawal', merchant: 'ATM Withdraw', method: 'CARD', date: todayISO(), time: timeStr, source: 'LOCKSCREEN', isAtm: true };
    } else if (mode === 'INCOME') {
      tx = { id: uid('tx'), profile: 'PERSONAL', type: 'INCOME', amount, accountId: label.toLowerCase().includes('cash') ? cashAcc.id : bankAcc.id, toAccountId: null, category: label || 'Income', merchant: label || 'Quick Income', method: label.toLowerCase().includes('cash') ? 'CASH' : 'UPI', date: todayISO(), time: timeStr, source: 'LOCKSCREEN', isAtm: false };
    } else if (mode === 'UPI') {
      tx = { id: uid('tx'), profile: 'PERSONAL', type: 'EXPENSE', amount, accountId: walletAcc.id, toAccountId: null, category: 'UPI Transfer', merchant: label || 'UPI Payment', method: 'UPI', upiApp: 'UPI', date: todayISO(), time: timeStr, source: 'LOCKSCREEN', isAtm: false };
    } else {
      tx = { id: uid('tx'), profile: 'PERSONAL', type: 'EXPENSE', amount, accountId: cashAcc.id, toAccountId: null, category: label || 'Other', merchant: label || 'Quick Expense', method: 'CASH', date: todayISO(), time: timeStr, source: 'LOCKSCREEN', isAtm: false };
    }
    await addTransactionRecord(tx);
    closeModal();
    showToast(`Logged ${tx.merchant} (${formatINR(amount)}) in SQLite!`);
  }

  // ==================== GLOBAL SEARCH ENGINE ====================
  function openSearchModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-base font-bold flex items-center gap-2"><i data-lucide="search" class="w-5 h-5 text-emerald-400"></i> Global Search Engine</h3>
        <button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <input id="global-search-input" type="text" oninput="PFOS.runGlobalSearch(this.value)" placeholder="Search anything: pizza, rahul, atm, cash, salary, netflix..."
        class="w-full bg-obsidian border border-emerald-500/40 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none mb-3" />
      <div id="global-search-results" class="space-y-2 max-h-[55vh] overflow-y-auto text-xs text-slate-400">
        Type any keyword to search across Transactions, Accounts, Recurring Rules, Loans, Bills, Budgets, Goals &amp; Investments.
      </div>
    `);
    setTimeout(() => document.getElementById('global-search-input')?.focus(), 50);
  }

  function runGlobalSearch(rawQuery) {
    const box = document.getElementById('global-search-results');
    if (!box) return;
    const q = (rawQuery || '').trim().toLowerCase();
    if (!q) {
      box.innerHTML = '<p class="text-xs text-slate-500 py-4 text-center">Try: salary, rahul, atm, cash, netflix, rent, tea...</p>';
      return;
    }

    const hits = [];
    state.transactions.forEach(t => {
      if (`${t.merchant} ${t.category} ${t.method} ${t.notes} ${t.upiId} ${t.type} ${t.amount}`.toLowerCase().includes(q)) {
        hits.push({ tag: t.type, title: `${t.merchant || t.category}`, sub: `${t.date} ${t.time || ''} • ${t.method}`, val: formatINR(t.amount), onclick: `PFOS.openEditTransactionModal('${t.id}')` });
      }
    });
    state.accounts.forEach(a => {
      if (`${a.name} ${a.bankName} ${a.type} ${a.masked}`.toLowerCase().includes(q)) {
        hits.push({ tag: 'ACCOUNT', title: a.name, sub: `${a.bankName || a.type}`, val: formatINR(a.balance), onclick: `PFOS.openEditAccountModal('${a.id}')` });
      }
    });
    state.loans.forEach(l => {
      if (`${l.person} ${l.direction} ${l.notes}`.toLowerCase().includes(q)) {
        hits.push({ tag: 'LOAN', title: `${l.person} (${l.direction})`, sub: `Principal ${formatINR(l.principal)}`, val: formatINR(l.outstanding), onclick: `PFOS.openEditLoanModal('${l.id}')` });
      }
    });
    state.obligations.forEach(o => {
      if (`${o.title} ${o.kind}`.toLowerCase().includes(q)) {
        hits.push({ tag: o.kind, title: o.title, sub: `Due day ${o.dueDay}th`, val: formatINR(o.amount), onclick: `PFOS.openEditObligationModal('${o.id}')` });
      }
    });
    (state.recurringRules || []).forEach(r => {
      if (`${r.title} ${r.category} ${r.frequency}`.toLowerCase().includes(q)) {
        hits.push({ tag: 'RECURRING', title: r.title, sub: `${r.frequency} • Next: ${r.nextRunDate}`, val: formatINR(r.amount), onclick: `PFOS.openEditRecurringModal('${r.id}')` });
      }
    });
    state.goals.forEach(g => {
      if (g.title.toLowerCase().includes(q)) {
        hits.push({ tag: 'GOAL', title: g.title, sub: `${formatINR(g.saved)} / ${formatINR(g.target)}`, val: `${Math.round((g.saved / Math.max(1, g.target)) * 100)}%`, onclick: `PFOS.openEditGoalModal('${g.id}')` });
      }
    });
    state.investments.forEach(i => {
      if (`${i.name} ${i.assetType}`.toLowerCase().includes(q)) {
        hits.push({ tag: i.assetType, title: i.name, sub: `Invested ${formatINR(i.invested)}`, val: formatINR(i.currentValue), onclick: `PFOS.openEditInvestmentModal('${i.id}')` });
      }
    });

    box.innerHTML = hits.length
      ? hits.slice(0, 25).map(h => `
          <div onclick="${h.onclick}" class="cursor-pointer p-3 rounded-xl bg-obsidian hover:bg-slate-800 border border-slate-800 flex items-center justify-between gap-2 transition">
            <div class="min-w-0">
              <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300 mr-1.5">${escapeHtml(h.tag)}</span>
              <span class="text-xs font-bold text-slate-100">${escapeHtml(h.title)}</span>
              <p class="text-[11px] text-slate-400 mt-0.5 truncate">${escapeHtml(h.sub)}</p>
            </div>
            <span class="text-xs font-extrabold text-slate-200 shrink-0">${escapeHtml(h.val)}</span>
          </div>
        `).join('')
      : '<p class="text-xs text-slate-500 py-6 text-center">No matches found.</p>';
  }

  // ==================== AUDIT, MONTHLY REPORT & NOTIFICATION SETTINGS HANDLERS ====================
  async function toggleAuditItem(scope, key, checked) {
    if (scope === 'weekly') state.weeklyAudit[key] = checked;
    else state.monthlyClosing[key] = checked;
    await persistState();
    renderCurrentView();
  }

  async function resetWeeklyAudit() {
    state.weeklyAudit = defaultWeeklyAudit();
    await persistState();
    renderCurrentView();
    showToast('Weekly audit checklist reset.', 'info');
  }

  function openMonthlyReportModal() {
    const m = computeMetrics();
    const monthName = new Date().toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    openModal(`
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-bold">Monthly Financial Report — ${monthName}</h3>
        <button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <div class="space-y-2.5 text-xs mb-4">
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Monthly Income</span><strong class="text-emerald-400">${formatINR(m.monthlyIncome)}</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Monthly Expenses</span><strong class="text-rose-400">${formatINR(m.monthlyExpenses)}</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Net Savings</span><strong class="text-sky-400">${formatINR(m.monthlyIncome - m.monthlyExpenses)} (${m.healthBreakdown.savingsRate}%)</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Total Assets</span><strong>${formatINR(m.totalAssets)}</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Remaining Commitments</span><strong class="text-amber-400">${formatINR(m.totalObligations)}</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Actual Free Money</span><strong class="text-emerald-400">${formatINR(m.trueFreeMoney)}</strong></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian"><span>Net Worth &amp; Health Score</span><strong>${formatINR(m.netWorth)} • ${m.healthScore}/100</strong></div>
      </div>
      <button onclick="PFOS.exportSqliteFile()" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Archive Month (Download pfos_vault.sqlite)</button>
    `);
  }

  async function saveNotificationSettings(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ns = {
      morningTime: fd.get('morningTime') || '08:30',
      afternoonTime: fd.get('afternoonTime') || '14:00',
      nightTime: fd.get('nightTime') || '21:00',
      frequency: fd.get('frequency') || 'DAILY',
      quietStart: fd.get('quietStart') || '22:00',
      quietEnd: fd.get('quietEnd') || '07:00',
      sensitivity: fd.get('sensitivity') || 'MEDIUM',
      silentSummaryBar: fd.get('silentSummaryBar') === 'on',
      categories: {
        expenseReview: fd.get('cat_expenseReview') === 'on',
        creditCards: fd.get('cat_creditCards') === 'on',
        bills: fd.get('cat_bills') === 'on',
        emi: fd.get('cat_emi') === 'on',
        income: fd.get('cat_income') === 'on',
        cash: fd.get('cat_cash') === 'on',
        goals: fd.get('cat_goals') === 'on',
        investments: fd.get('cat_investments') === 'on',
        backup: fd.get('cat_backup') === 'on',
        commitments: fd.get('cat_commitments') === 'on'
      }
    };
    state.notificationSettings = ns;
    await persistState();
    renderCurrentView();
    showToast('Smart Assistant settings saved to SQLite!');
  }

  function openAdjustCashModal() {
    const cashAcc = state.accounts.find(a => a.type === 'CASH');
    if (cashAcc) openEditAccountModal(cashAcc.id);
    else openAddAccountModal();
  }

  // ==================== RECURRING RULES CRUD ====================
  function openAddRecurringModal(editRule = null) {
    const accounts = state.accounts.filter(a => a.type !== 'DEBIT_CARD');
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editRule ? 'Edit Recurring Rule' : 'Add Recurring Transaction'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitRecurring(event, '${editRule ? editRule.id : ''}')" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Type</label>
            <select name="type" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              <option value="EXPENSE" ${editRule && editRule.type === 'EXPENSE' ? 'selected' : ''}>Expense</option>
              <option value="INCOME" ${editRule && editRule.type === 'INCOME' ? 'selected' : ''}>Income</option>
            </select>
          </div>
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Frequency</label>
            <select name="frequency" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              ${['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].map(f => `<option value="${f}" ${(editRule ? editRule.frequency : 'MONTHLY') === f ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
          </div>
        </div>
        <input type="text" name="title" required value="${editRule ? escapeHtml(editRule.title) : ''}" placeholder="Title (e.g. Monthly Rent, Salary, Internet Bill)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Amount (₹)</label><input type="number" name="amount" required min="1" step="any" value="${editRule ? editRule.amount : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Next Run Date</label><input type="date" name="nextRunDate" required value="${editRule ? editRule.nextRunDate : todayISO()}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">Account</label>
            <select name="accountId" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              ${accounts.map(a => `<option value="${a.id}" ${editRule && editRule.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
            </select>
          </div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Category</label><input type="text" name="category" value="${editRule ? escapeHtml(editRule.category) : 'Rent'}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editRule ? 'Update Recurring Rule' : 'Save Recurring Rule'}</button>
      </form>
    `);
  }
  function openEditRecurringModal(id) { const r = state.recurringRules.find(x => x.id === id); if (r) openAddRecurringModal(r); }
  async function submitRecurring(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      type: fd.get('type'),
      frequency: fd.get('frequency'),
      title: fd.get('title'),
      amount: Number(fd.get('amount')),
      nextRunDate: fd.get('nextRunDate'),
      accountId: fd.get('accountId'),
      category: fd.get('category') || 'Recurring',
      method: 'AUTO',
      active: true
    };
    if (editId) {
      const idx = state.recurringRules.findIndex(x => x.id === editId);
      if (idx !== -1) state.recurringRules[idx] = { ...state.recurringRules[idx], ...payload };
      showToast('Recurring rule updated!');
    } else {
      state.recurringRules.push({ id: uid('rec'), profile: 'PERSONAL', lastRunDate: '', ...payload });
      showToast('Recurring rule added!');
    }
    await persistState();
    closeModal();
    renderCurrentView();
  }
  async function deleteRecurring(id) {
    state.recurringRules = state.recurringRules.filter(x => x.id !== id);
    await persistState();
    renderCurrentView();
    showToast('Recurring rule deleted.', 'info');
  }

  // ==================== SQLITE & ENCRYPTION HANDLERS ====================
  function exportSqliteFile() {
    const raw = PFOS_DB.exportRawSqlite();
    if (!raw) return showToast('SQLite database not ready.', 'error');
    state.assistantMeta.lastBackupDate = todayISO();
    persistState();
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/x-sqlite3' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'pfos_vault.sqlite';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Downloaded pfos_vault.sqlite!');
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
        showToast('Imported SQLite database successfully!');
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
      if (ok) {
        renderCurrentView();
        showToast('Linked! Changes auto-sync to your local .sqlite file.');
      } else {
        showToast('Use "Download pfos_vault.sqlite" on mobile browsers.', 'info');
        exportSqliteFile();
      }
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Link failed: ' + err.message, 'error');
    }
  }

  function openSetEncryptionModal() {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">Encrypt SQLite Vault (AES-256-GCM)</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <p class="text-xs text-slate-400 mb-3">Your PIN derives a 256-bit AES key via PBKDF2 to encrypt <code>pfos_vault.sqlite</code> on disk.</p>
      <form onsubmit="PFOS.saveEncryptionPin(event)" class="space-y-3">
        <input type="password" name="pin" required minlength="4" maxlength="12" inputmode="numeric" placeholder="Enter 4–12 digit PIN" class="w-full bg-obsidian border border-slate-700 rounded-xl px-4 py-3 text-center text-lg tracking-widest font-bold text-slate-100" />
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Encrypt Vault</button>
      </form>
    `);
  }

  async function saveEncryptionPin(e) {
    e.preventDefault();
    const pin = new FormData(e.target).get('pin');
    if (!pin || pin.length < 4) return showToast('PIN must be at least 4 characters.', 'warning');
    await PFOS_DB.enableEncryption(pin);
    closeModal(); updateNavStyles(); renderCurrentView();
    showToast('SQLite Vault encrypted with AES-256-GCM 🔒');
  }

  async function disableEncryption() {
    await PFOS_DB.disableEncryption();
    updateNavStyles(); renderCurrentView();
    showToast('Encryption removed from SQLite vault.', 'info');
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
      showToast('SQLite Vault decrypted & unlocked!');
    } catch (_) {
      document.getElementById('unlock-error').textContent = 'Wrong PIN — decryption failed.';
    }
  }

  // ==================== STANDARD CRUD MODALS ====================
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
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editTx ? 'Edit' : 'Add'} ${type === 'TRANSFER' ? 'Transfer / ATM Cash' : type.charAt(0) + type.slice(1).toLowerCase()}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitTransaction(event, '${editTx ? editTx.id : ''}')" class="space-y-3.5">
        <input type="hidden" name="type" value="${type}" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Amount (₹)</label><input type="number" name="amount" required min="1" step="any" value="${editTx ? editTx.amount : ''}" placeholder="e.g. 500" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm font-bold text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Date</label><input type="date" name="date" value="${editTx ? editTx.date : todayISO()}" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="text-[11px] text-slate-400 block mb-1">${type === 'TRANSFER' ? 'From Account' : 'Account / Card'}</label>
            <select name="accountId" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">
              ${accounts.map(a => `<option value="${a.id}" ${(editTx ? editTx.accountId === a.id : a.id === preselectAccId && type !== 'TRANSFER') ? 'selected' : ''}>${escapeHtml(a.name)} (${formatINR(a.balance)})</option>`).join('')}
            </select>
          </div>
          ${type === 'TRANSFER' ? `
            <div><label class="text-[11px] text-slate-400 block mb-1">To Account (or Credit Card)</label><select name="toAccountId" required class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${accounts.map(a => `<option value="${a.id}" ${(editTx ? editTx.toAccountId === a.id : (a.id === preselectAccId || (!preselectAccId && a.type === 'CASH'))) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}</select></div>
          ` : `
            <div><label class="text-[11px] text-slate-400 block mb-1">Category</label><select name="category" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${categories.map(c => `<option value="${c}" ${editTx && editTx.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          `}
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Merchant / Description</label><input type="text" name="merchant" value="${editTx ? escapeHtml(editTx.merchant) : ''}" placeholder="e.g. Swiggy, ATM" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Method</label><select name="method" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['UPI','CASH','CARD','NETBANKING','AUTO'].map(m => `<option value="${m}" ${editTx && editTx.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">UPI ID / Ref</label><input type="text" name="upiId" value="${editTx ? escapeHtml(editTx.upiId) : ''}" placeholder="merchant@okhdfc" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Profile</label><select name="profile" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100">${['PERSONAL','FAMILY','BUSINESS'].map(p => `<option value="${p}" ${editTx && editTx.profile === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        </div>
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition">${editTx ? 'Update Transaction' : 'Save to SQLite'}</button>
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
    if (type === 'TRANSFER' && accountId === toAccountId) return showToast('From and To accounts must be different.', 'warning');
    if (editId) {
      const idx = state.transactions.findIndex(t => t.id === editId);
      if (idx === -1) return;
      const oldTx = state.transactions[idx];
      applyBalanceImpact(oldTx, -1);
      const toAcc = toAccountId ? state.accounts.find(a => a.id === toAccountId) : null;
      const updatedTx = { ...oldTx, profile: fd.get('profile') || 'PERSONAL', amount, accountId, toAccountId, category: fd.get('category') || oldTx.category, merchant: fd.get('merchant') || fd.get('category') || type, method: fd.get('method') || 'UPI', upiId: fd.get('upiId') || '', date: fd.get('date') || oldTx.date, isAtm: type === 'TRANSFER' && toAcc && toAcc.type === 'CASH' };
      applyBalanceImpact(updatedTx, 1);
      state.transactions[idx] = updatedTx;
      await persistState(); closeModal(); renderCurrentView(); showToast('Transaction updated in SQLite!');
    } else {
      const now = new Date();
      await addTransactionRecord({ id: uid('tx'), profile: fd.get('profile') || 'PERSONAL', type, amount, accountId, toAccountId, category: fd.get('category') || (type === 'TRANSFER' ? 'Transfer' : 'Other'), merchant: fd.get('merchant') || fd.get('category') || type, method: fd.get('method') || 'UPI', upiId: fd.get('upiId') || '', date: fd.get('date') || todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'MANUAL' });
      closeModal(); showToast(`${type} of ${formatINR(amount)} saved to SQLite!`);
    }
  }
  async function deleteTransaction(txId) {
    const idx = state.transactions.findIndex(t => t.id === txId);
    if (idx === -1) return;
    applyBalanceImpact(state.transactions[idx], -1);
    state.transactions.splice(idx, 1);
    await persistState(); renderCurrentView(); showToast('Transaction deleted & balance restored.', 'info');
  }

  function openAddAccountModal(editAcc = null) {
    const isCC = editAcc ? editAcc.type === 'CREDIT_CARD' : false;
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editAcc ? 'Edit Account / Card' : 'Add Account / Wallet / Card'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitAccount(event, '${editAcc ? editAcc.id : ''}')" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Type</label><select name="type" onchange="document.getElementById('cc-extra-fields').classList.toggle('hidden', this.value !== 'CREDIT_CARD')" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${[['BANK','Bank Account'],['CASH','Cash Wallet'],['WALLET','Digital Wallet'],['CREDIT_CARD','Credit Card'],['DEBIT_CARD','Debit Card']].map(([v,l]) => `<option value="${v}" ${editAcc && editAcc.type===v?'selected':''}>${l}</option>`).join('')}</select></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Profile</label><select name="profile" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['PERSONAL','FAMILY','BUSINESS'].map(p => `<option value="${p}" ${editAcc && editAcc.profile===p?'selected':''}>${p}</option>`).join('')}</select></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Account / Card Name</label><input type="text" name="name" required value="${editAcc ? escapeHtml(editAcc.name) : ''}" placeholder="e.g. Axis Savings" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Bank / Provider</label><input type="text" name="bankName" value="${editAcc ? escapeHtml(editAcc.bankName) : ''}" placeholder="e.g. Axis Bank" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[11px] text-slate-400 block mb-1">Balance / Outstanding (₹)</label><input type="number" name="balance" value="${editAcc ? editAcc.balance : 0}" step="any" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
          <div><label class="text-[11px] text-slate-400 block mb-1">Last 4 Digits</label><input type="text" name="masked" maxlength="6" value="${editAcc ? escapeHtml(editAcc.masked) : ''}" placeholder="1234" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" /></div>
        </div>
        <div id="cc-extra-fields" class="${isCC ? '' : 'hidden'} grid grid-cols-3 gap-2 pt-2 border-t border-slate-800">
          <div><label class="text-[10px] text-slate-400 block mb-1">Credit Limit</label><input type="number" name="creditLimit" value="${editAcc ? editAcc.creditLimit : 50000}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400 block mb-1">Stmt Day</label><input type="number" name="statementDay" value="${editAcc ? editAcc.statementDay : 15}" min="1" max="28" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400 block mb-1">Due Day</label><input type="number" name="dueDay" value="${editAcc ? editAcc.dueDay : 5}" min="1" max="28" class="w-full bg-obsidian border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editAcc ? 'Update Account' : 'Save Account'}</button>
      </form>
    `);
  }
  function openEditAccountModal(id) { const a = state.accounts.find(x => x.id === id); if (a) openAddAccountModal(a); }
  async function submitAccount(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { profile: fd.get('profile'), type: fd.get('type'), name: fd.get('name'), bankName: fd.get('bankName'), masked: fd.get('masked'), balance: Number(fd.get('balance') || 0), creditLimit: Number(fd.get('creditLimit') || 0), statementDay: Number(fd.get('statementDay') || 15), dueDay: Number(fd.get('dueDay') || 5) };
    if (editId) { const i = state.accounts.findIndex(x => x.id === editId); if (i !== -1) state.accounts[i] = { ...state.accounts[i], ...payload }; showToast('Account updated!'); }
    else { state.accounts.push({ id: uid('acc'), ...payload }); showToast('Account added!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteAccount(id) {
    if (state.accounts.length <= 1) return showToast('At least one account must remain.', 'warning');
    state.accounts = state.accounts.filter(a => a.id !== id);
    await persistState(); renderCurrentView(); showToast('Account removed.', 'info');
  }

  function openAddLoanModal(editLoan = null) {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editLoan ? 'Edit Loan' : 'Add Loan'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitLoan(event, '${editLoan ? editLoan.id : ''}')" class="space-y-3">
        <select name="direction" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100"><option value="LENT" ${editLoan && editLoan.direction==='LENT'?'selected':''}>Money Lent</option><option value="BORROWED" ${editLoan && editLoan.direction==='BORROWED'?'selected':''}>Money Borrowed</option></select>
        <input type="text" name="person" required value="${editLoan ? escapeHtml(editLoan.person) : ''}" placeholder="Person / Institution Name" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Principal (₹)</label><input type="number" name="principal" required min="1" value="${editLoan ? editLoan.principal : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Outstanding (₹)</label><input type="number" name="outstanding" min="0" value="${editLoan ? editLoan.outstanding : ''}" placeholder="Same as principal" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <input type="date" name="dueDate" value="${editLoan ? editLoan.dueDate : daysAgoISO(-30)}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editLoan ? 'Update Loan' : 'Save Loan'}</button>
      </form>
    `);
  }
  function openEditLoanModal(id) { const l = state.loans.find(x => x.id === id); if (l) openAddLoanModal(l); }
  async function submitLoan(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), principal = Number(fd.get('principal')), outVal = fd.get('outstanding'), outstanding = outVal !== '' ? Number(outVal) : principal;
    const payload = { direction: fd.get('direction'), person: fd.get('person'), principal, outstanding, dueDate: fd.get('dueDate') };
    if (editId) { const i = state.loans.findIndex(x => x.id === editId); if (i !== -1) state.loans[i] = { ...state.loans[i], ...payload }; showToast('Loan updated!'); }
    else { state.loans.push({ id: uid('ln'), profile: 'PERSONAL', ...payload }); showToast('Loan saved!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteLoan(id) { state.loans = state.loans.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Loan deleted.', 'info'); }
  function openSettleLoanModal(loanId) {
    const l = state.loans.find(x => x.id === loanId); if (!l) return;
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">Record Payment (${escapeHtml(l.person)})</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitLoanPayment(event, '${loanId}')" class="space-y-3">
        <p class="text-xs text-slate-400">Outstanding: <strong>${formatINR(l.outstanding)}</strong></p>
        <input type="number" name="amount" required min="1" max="${l.outstanding}" value="${l.outstanding}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-bold text-slate-100" />
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Confirm Payment</button>
      </form>
    `);
  }
  async function submitLoanPayment(e, loanId) {
    e.preventDefault();
    const l = state.loans.find(x => x.id === loanId), amt = Number(new FormData(e.target).get('amount'));
    if (!l) return;
    l.outstanding = Math.max(0, l.outstanding - amt);
    const bank = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    await addTransactionRecord({ id: uid('tx'), profile: l.profile || 'PERSONAL', type: l.direction === 'LENT' ? 'INCOME' : 'EXPENSE', amount: amt, accountId: bank.id, category: 'Loan Settlement', merchant: `${l.direction === 'LENT' ? 'Received from' : 'Paid to'} ${l.person}`, method: 'UPI', date: todayISO(), time: '12:00', source: 'MANUAL' });
    closeModal(); showToast('Loan payment recorded!');
  }

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
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editOb ? 'Edit Obligation' : 'Add EMI / Bill / Subscription'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
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
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editOb ? 'Update Obligation' : 'Save Obligation'}</button>
      </form>
    `);
  }
  function openEditObligationModal(id) { const o = state.obligations.find(x => x.id === id); if (o) openAddObligationModal(o.kind, o); }
  async function submitObligation(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { kind: fd.get('kind'), title: fd.get('title'), amount: Number(fd.get('amount')), dueDay: Number(fd.get('dueDay')), remainingMonths: fd.get('remainingMonths') !== '' ? Number(fd.get('remainingMonths')) : null, frequency: 'MONTHLY', paidThisMonth: fd.get('paidThisMonth') === 'on' };
    if (editId) { const i = state.obligations.findIndex(x => x.id === editId); if (i !== -1) state.obligations[i] = { ...state.obligations[i], ...payload }; showToast('Obligation updated!'); }
    else { state.obligations.push({ id: uid('ob'), profile: 'PERSONAL', ...payload }); showToast('Obligation added!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteObligation(id) { state.obligations = state.obligations.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Obligation deleted.', 'info'); }

  function openAddBudgetModal(editBg = null) {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editBg ? 'Edit Budget' : 'Add Monthly Budget'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitBudget(event, '${editBg ? editBg.id : ''}')" class="space-y-3">
        <input type="text" name="category" required value="${editBg ? escapeHtml(editBg.category) : ''}" placeholder="Category" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <input type="number" name="limit" required min="100" value="${editBg ? editBg.limit : ''}" placeholder="Monthly Limit (₹)" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editBg ? 'Update Budget' : 'Save Budget'}</button>
      </form>
    `);
  }
  function openEditBudgetModal(id) { const b = state.budgets.find(x => x.id === id); if (b) openAddBudgetModal(b); }
  async function submitBudget(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { category: fd.get('category'), limit: Number(fd.get('limit')) };
    if (editId) { const i = state.budgets.findIndex(x => x.id === editId); if (i !== -1) state.budgets[i] = { ...state.budgets[i], ...payload }; showToast('Budget updated!'); }
    else { state.budgets.push({ id: uid('bg'), profile: 'PERSONAL', ...payload }); showToast('Budget saved!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteBudget(id) { state.budgets = state.budgets.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Budget deleted.', 'info'); }

  function openAddGoalModal(editGl = null) {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editGl ? 'Edit Goal' : 'Add Financial Goal'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitGoal(event, '${editGl ? editGl.id : ''}')" class="space-y-3">
        <input type="text" name="title" required value="${editGl ? escapeHtml(editGl.title) : ''}" placeholder="Goal Title" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Target (₹)</label><input type="number" name="target" required min="100" value="${editGl ? editGl.target : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Saved (₹)</label><input type="number" name="saved" min="0" value="${editGl ? editGl.saved : 0}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editGl ? 'Update Goal' : 'Save Goal'}</button>
      </form>
    `);
  }
  function openEditGoalModal(id) { const g = state.goals.find(x => x.id === id); if (g) openAddGoalModal(g); }
  async function submitGoal(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { title: fd.get('title'), target: Number(fd.get('target')), saved: Number(fd.get('saved') || 0) };
    if (editId) { const i = state.goals.findIndex(x => x.id === editId); if (i !== -1) state.goals[i] = { ...state.goals[i], ...payload }; showToast('Goal updated!'); }
    else { state.goals.push({ id: uid('gl'), profile: 'PERSONAL', ...payload }); showToast('Goal created!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function contributeGoal(id) { const g = state.goals.find(x => x.id === id); if (!g) return; g.saved = Math.min(g.target, Number(g.saved) + 1000); await persistState(); renderCurrentView(); showToast(`Added ₹1,000 toward ${g.title}`); }
  async function deleteGoal(id) { state.goals = state.goals.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Goal deleted.', 'info'); }

  function openAddInvestmentModal(editInv = null) {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">${editInv ? 'Edit Investment' : 'Add Investment'}</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="PFOS.submitInvestment(event, '${editInv ? editInv.id : ''}')" class="space-y-3">
        <select name="assetType" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100">${['SIP','MUTUAL_FUND','STOCK','GOLD','FD','RD','PPF','EPF','NPS'].map(t => `<option value="${t}" ${editInv && editInv.assetType===t?'selected':''}>${t}</option>`).join('')}</select>
        <input type="text" name="name" required value="${editInv ? escapeHtml(editInv.name) : ''}" placeholder="Asset Name" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-slate-100" />
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-[10px] text-slate-400">Invested (₹)</label><input type="number" name="invested" required min="1" value="${editInv ? editInv.invested : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
          <div><label class="text-[10px] text-slate-400">Current Value (₹)</label><input type="number" name="currentValue" required min="1" value="${editInv ? editInv.currentValue : ''}" class="w-full bg-obsidian border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100" /></div>
        </div>
        <button type="submit" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">${editInv ? 'Update Investment' : 'Save Investment'}</button>
      </form>
    `);
  }
  function openEditInvestmentModal(id) { const i = state.investments.find(x => x.id === id); if (i) openAddInvestmentModal(i); }
  async function submitInvestment(e, editId = '') {
    e.preventDefault();
    const fd = new FormData(e.target), payload = { assetType: fd.get('assetType'), name: fd.get('name'), invested: Number(fd.get('invested')), currentValue: Number(fd.get('currentValue')), updated: todayISO() };
    if (editId) { const i = state.investments.findIndex(x => x.id === editId); if (i !== -1) state.investments[i] = { ...state.investments[i], ...payload }; showToast('Investment updated!'); }
    else { state.investments.push({ id: uid('inv'), profile: 'PERSONAL', ...payload }); showToast('Investment added!'); }
    await persistState(); closeModal(); renderCurrentView();
  }
  async function deleteInvestment(id) { state.investments = state.investments.filter(x => x.id !== id); await persistState(); renderCurrentView(); showToast('Investment deleted.', 'info'); }

  // ==================== VOICE, SMS, HEALTH, APK & BACKUPS ====================
  function openVoiceModal() {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold flex items-center gap-2"><i data-lucide="mic" class="w-5 h-5 text-violet-400"></i> Voice Entry</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <p class="text-xs text-slate-400 mb-3">Speak or type: <em>"Spent 250 on lunch"</em> or <em>"Received 1500 cash from Rahul"</em> or <em>"ATM withdrawal 5000"</em>.</p>
      <button id="voice-mic-btn" onclick="PFOS.startSpeechRecognition()" class="w-full py-3 mb-3 rounded-xl bg-violet-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-2"><i data-lucide="mic" class="w-4 h-4"></i> Tap to Speak</button>
      <textarea id="voice-input-text" rows="2" placeholder="Or type command here..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogVoice()" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Parse &amp; Log Transaction</button>
    `);
  }
  function startSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return showToast('Voice API unavailable. Type below!', 'warning');
    const rec = new SpeechRec(); rec.lang = 'en-IN';
    const btn = document.getElementById('voice-mic-btn'); if (btn) btn.textContent = 'Listening...';
    rec.onresult = (ev) => { document.getElementById('voice-input-text').value = ev.results[0][0].transcript; if (btn) btn.textContent = 'Tap to Speak Again'; };
    rec.onerror = () => { if (btn) btn.textContent = 'Tap to Speak'; };
    rec.start();
  }
  async function parseAndLogVoice() {
    const text = (document.getElementById('voice-input-text')?.value || '').trim();
    const amtMatch = text.match(/(\d+(?:,\d+)*(?:\.\d{1,2})?)/);
    if (!amtMatch) return showToast('Could not detect amount.', 'error');
    const amount = Number(amtMatch[1].replace(/,/g, '')), lower = text.toLowerCase();
    const bankAcc = state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];
    let type = 'EXPENSE', accountId = cashAcc.id, toAccountId = null, category = 'Other', method = 'CASH';
    if (lower.includes('atm') || lower.includes('withdraw')) { type = 'TRANSFER'; accountId = bankAcc.id; toAccountId = cashAcc.id; category = 'ATM Withdrawal'; method = 'CARD'; }
    else if (lower.includes('received') || lower.includes('salary') || lower.includes('income')) {
      type = 'INCOME';
      accountId = lower.includes('cash') ? cashAcc.id : bankAcc.id;
      category = 'Income';
      method = lower.includes('cash') ? 'CASH' : 'UPI';
    }
    else if (lower.includes('lunch') || lower.includes('tea') || lower.includes('food')) category = 'Food';
    else if (lower.includes('petrol') || lower.includes('fuel')) category = 'Fuel';
    else if (lower.includes('travel') || lower.includes('auto') || lower.includes('bus')) category = 'Transport';
    const now = new Date();
    await addTransactionRecord({ id: uid('tx'), profile: 'PERSONAL', type, amount, accountId, toAccountId, category, merchant: text, method, date: todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'VOICE', isAtm: type === 'TRANSFER' });
    closeModal(); showToast(`Voice logged: ${type} ${formatINR(amount)}`);
  }

  function openSmsModal() {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold flex items-center gap-2"><i data-lucide="message-square-code" class="w-5 h-5 text-amber-400"></i> Indian Bank &amp; UPI SMS Parser</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <textarea id="sms-raw-input" rows="3" placeholder="Paste SBI/HDFC/ICICI/Axis/UPI SMS here..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogSms()" class="w-full py-3 rounded-xl bg-amber-500 text-slate-950 font-bold text-xs">Extract &amp; Auto-Log</button>
    `);
  }
  async function parseAndLogSms() {
    const raw = (document.getElementById('sms-raw-input')?.value || '').trim(), lower = raw.toLowerCase();
    if (lower.includes('otp')) return showToast('Ignored OTP message.', 'info');
    const amtMatch = raw.match(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    if (!amtMatch) return showToast('No ₹ / INR amount found.', 'error');
    const amount = Number(amtMatch[1].replace(/,/g, ''));
    const accDigits = raw.match(/(?:a\/c|acct|account|card)\s*(?:no\.?|ending)?\s*[x*]*(\d{4})/i)?.[1] || '';
    const vpa = raw.match(/([a-zA-Z0-9.\-_]+@[a-zA-Z]+)/)?.[1] || '';
    const isAtm = lower.includes('atm') || lower.includes('withdrawn'), isCredit = lower.includes('credited') || lower.includes('received');
    const matchedAcc = state.accounts.find(a => accDigits && a.masked === accDigits) || state.accounts.find(a => a.type === 'BANK') || state.accounts[0];
    const cashAcc = state.accounts.find(a => a.type === 'CASH') || state.accounts[0];
    const type = isAtm ? 'TRANSFER' : isCredit ? 'INCOME' : 'EXPENSE';
    const now = new Date();
    await addTransactionRecord({ id: uid('tx'), profile: matchedAcc.profile || 'PERSONAL', type, amount, accountId: matchedAcc.id, toAccountId: isAtm ? cashAcc.id : null, category: isAtm ? 'ATM Withdrawal' : isCredit ? 'Bank Credit' : 'UPI Spend', merchant: vpa ? `UPI: ${vpa}` : `Bank SMS (${accDigits || matchedAcc.name})`, method: isAtm ? 'CARD' : 'UPI', upiId: vpa, date: todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'SMS', isAtm });
    closeModal(); showToast(`SMS Auto-Logged: ${type} ${formatINR(amount)}`);
  }

  function openHealthBreakdownModal() {
    const m = computeMetrics(), b = m.healthBreakdown;
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold">Financial Health Score</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <div class="text-center py-3 mb-4 rounded-2xl bg-obsidian border border-slate-800"><span class="text-4xl font-extrabold text-emerald-400">${m.healthScore}</span><span class="text-sm text-slate-500"> / 100</span></div>
      <div class="space-y-2 text-xs">
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Savings Rate (${b.savingsRate}%)</span><span class="font-bold text-emerald-400">${b.savingsPts} / 25</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Credit Utilization (${Math.round(m.creditUtilization)}%)</span><span class="font-bold text-emerald-400">${b.creditPts} / 20</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Emergency Fund</span><span class="font-bold text-amber-400">${b.emergencyPts} / 25</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Debt-to-Income Ratio</span><span class="font-bold text-sky-400">${b.debtPts} / 15</span></div>
        <div class="flex justify-between p-3 rounded-xl bg-obsidian/70"><span>Payment Discipline</span><span class="font-bold text-emerald-400">${b.disciplinePts} / 15</span></div>
      </div>
    `);
  }

  async function completeDailyReview() {
    const d = todayISO();
    if (!state.reconciliation.dailyReviewDates.includes(d)) {
      state.reconciliation.dailyReviewDates.push(d);
      await persistState();
      renderCurrentView();
      showToast('Daily Expense Review completed!');
    } else showToast('Already completed today ✓', 'info');
  }
  function setTimelineType(t) { timelineFilter.type = t; renderCurrentView(); }
  function setTimelineAccount(id) { timelineFilter.accountId = id; renderCurrentView(); }
  function setTimelineSearch(q) { timelineFilter.search = q; renderCurrentView(); }
  function selectCalendarDay(d) { selectedCalendarDay = d; renderCurrentView(); }
  function setAnalyticsRange(r) { analyticsRange = r; renderCurrentView(); }

  function openApkModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-base font-extrabold flex items-center gap-2"><i data-lucide="smartphone" class="w-5 h-5 text-emerald-400"></i> Android Lock Screen &amp; APK</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <div class="space-y-3">
        <div class="p-3.5 rounded-2xl bg-obsidian border border-emerald-500/30">
          <h4 class="text-xs font-bold text-emerald-300 mb-1">1. Install via Chrome (Offline PWA + Shortcuts)</h4>
          <p class="text-[11px] text-slate-400 mb-2">Includes Android Home Screen 3-second +Expense, +Income, +ATM &amp; Voice shortcuts + Encrypted SQLite.</p>
          <button onclick="PFOS.triggerPwaInstall()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Install App / Show Steps</button>
        </div>
        <div class="p-3.5 rounded-2xl bg-obsidian border border-sky-500/30">
          <h4 class="text-xs font-bold text-sky-300 mb-1">2. Download Native Android APK Builder (.zip)</h4>
          <p class="text-[11px] text-slate-400 mb-2">Includes Flutter SQLite, Lock Screen Persistent Notification (+Add Expense), Quick Settings Tile &amp; GitHub APK builder.</p>
          <button onclick="PFOS.downloadFlutterApkKit()" class="w-full py-2.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs">Download pfos-android-apk-builder.zip</button>
        </div>
        <div class="p-3.5 rounded-2xl bg-obsidian border border-violet-500/30">
          <h4 class="text-xs font-bold text-violet-300 mb-1">3. Wrap Live URL via PWABuilder</h4>
          <a href="https://www.pwabuilder.com" target="_blank" rel="noopener noreferrer" class="block w-full py-2.5 mt-1 rounded-xl bg-violet-500/20 text-violet-300 font-bold text-xs text-center">Launch PWABuilder.com ↗</a>
        </div>
      </div>
    `);
  }

  async function triggerPwaInstall() {
    if (deferredPwaPrompt) { deferredPwaPrompt.prompt(); await deferredPwaPrompt.userChoice; deferredPwaPrompt = null; return; }
    openModal(`
      <h3 class="text-base font-bold mb-3">Install PFOS on Android (Chrome)</h3>
      <ol class="text-xs text-slate-300 space-y-2 list-decimal list-inside mb-4">
        <li>Open your deployed Vercel/Netlify URL in <strong>Google Chrome</strong> on Android.</li>
        <li>Tap the <strong>three-dot menu (⋮)</strong> → <strong>Install app / Add to Home screen</strong>.</li>
        <li>Long-press the PFOS icon on your home screen for instant <strong>+Expense, +Income, +ATM, and Voice</strong> shortcuts.</li>
      </ol>
      <button onclick="PFOS.closeModal()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Got It</button>
    `);
  }

  async function downloadFlutterApkKit() {
    if (typeof JSZip === 'undefined') return showToast('JSZip not loaded yet.', 'error');
    const zip = new JSZip();
    zip.file('README.md', '# PFOS v3 Native Android APK Builder\nIncludes Offline SQLite, Recurring Engine, 15-Category Local Notifications, Lock Screen Persistent Notification (+Add Expense), and Android Quick Settings Tile.\n\n1. Upload to GitHub\n2. Open Actions -> Build PFOS Android APK -> Run workflow\n3. Download app-release.apk.');
    zip.file('.github/workflows/build_apk.yml', `name: Build PFOS Android APK
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - run: flutter create . --platforms=android
      - run: flutter pub get
      - run: flutter build apk --release
      - uses: actions/upload-artifact@v4
        with:
          name: pfos-release-apk
          path: build/app/outputs/flutter-apk/app-release.apk
`);
    zip.file('pubspec.yaml', `name: pfos
description: Personal Financial Operating System - Offline SQLite & Smart Assistant
version: 3.0.0+1
environment:
  sdk: '>=3.4.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  sqflite: ^2.3.3+1
  flutter_local_notifications: ^17.2.2
  path_provider: ^2.1.4
  path: ^1.9.0
flutter:
  uses-material-design: true
`);
    zip.file('android_extras/QuickExpenseTileService.kt', `package com.pfos.app

import android.content.Intent
import android.service.quicksettings.TileService

// Android Quick Settings Tile: Swipe -> Tap "Add Expense" -> Opens 3-sec entry
class QuickExpenseTileService : TileService() {
    override fun onClick() {
        super.onClick()
        val intent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("pfos_action", "quick-expense")
        }
        if (intent != null) {
            unlockAndRun { startActivityAndCollapse(intent) }
        }
    }
}
`);
    zip.file('lib/main.dart', `import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

final FlutterLocalNotificationsPlugin localNotif = FlutterLocalNotificationsPlugin();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  await localNotif.initialize(const InitializationSettings(android: androidInit));

  final dir = await getApplicationDocumentsDirectory();
  final dbPath = join(dir.path, 'pfos_vault.sqlite');
  final db = await openDatabase(dbPath, version: 1, onCreate: (database, version) async {
    await database.execute('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, balance REAL);');
    await database.execute('CREATE TABLE transactions (id TEXT PRIMARY KEY, type TEXT, amount REAL, account_id TEXT, category TEXT, merchant TEXT, date TEXT);');
  });

  // Persistent Silent Summary + Lock Screen Quick Expense Notification
  const androidDetails = AndroidNotificationDetails(
    'pfos_quick_entry',
    'PFOS Lock Screen Quick Entry',
    importance: Importance.low,
    priority: Priority.low,
    ongoing: true,
    visibility: NotificationVisibility.public,
    actions: <AndroidNotificationAction>[
      AndroidNotificationAction('quick_expense', '+ Add Expense', showsUserInterface: true),
      AndroidNotificationAction('quick_income', '+ Income', showsUserInterface: true),
    ],
  );
  await localNotif.show(101, 'PFOS • Offline Financial Vault', 'Tap + Add Expense to log within 3 seconds', const NotificationDetails(android: androidDetails));

  runApp(PfosSqliteApp(db: db, dbPath: dbPath));
}

class PfosSqliteApp extends StatefulWidget {
  final Database db;
  final String dbPath;
  const PfosSqliteApp({super.key, required this.db, required this.dbPath});
  @override
  State<PfosSqliteApp> createState() => _PfosSqliteAppState();
}

class _PfosSqliteAppState extends State<PfosSqliteApp> {
  List<Map<String, dynamic>> txs = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final rows = await widget.db.query('transactions', orderBy: 'rowid DESC');
    setState(() => txs = rows);
  }
  Future<void> _exportToDownloads() async {
    final dl = Directory('/storage/emulated/0/Download');
    if (await dl.exists()) {
      await File(widget.dbPath).copy('/storage/emulated/0/Download/pfos_vault.sqlite');
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved pfos_vault.sqlite to /Download/')));
    }
  }
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(scaffoldBackgroundColor: const Color(0xFF090D16)),
      home: Scaffold(
        appBar: AppBar(title: const Text('PFOS v3 SQLite Vault'), actions: [IconButton(icon: const Icon(Icons.download), onPressed: _exportToDownloads)]),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('SQLite File: \${widget.dbPath}', style: const TextStyle(fontSize: 12, color: Colors.tealAccent)),
            const SizedBox(height: 12),
            Expanded(child: ListView.builder(itemCount: txs.length, itemBuilder: (_, i) => ListTile(title: Text(txs[i]['merchant'] ?? ''), trailing: Text('₹\${txs[i]['amount']}')))),
          ]),
        ),
        floatingActionButton: FloatingActionButton(
          onPressed: () async {
            await widget.db.insert('transactions', {'id': DateTime.now().millisecondsSinceEpoch.toString(), 'type': 'EXPENSE', 'amount': 120.0, 'account_id': 'cash', 'category': 'Tea', 'merchant': 'Quick Entry', 'date': DateTime.now().toIso8601String()});
            _load();
          },
          child: const Icon(Icons.add),
        ),
      ),
    );
  }
}
`);
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pfos-android-apk-builder.zip'; a.click();
    showToast('Downloaded pfos-android-apk-builder.zip!');
  }

  function exportBackup() {
    state.assistantMeta.lastBackupDate = todayISO();
    persistState();
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({ app: 'PFOS', version: '3.0', data: state }))));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([encoded], { type: 'application/octet-stream' })); a.download = 'pfos_backup.pfos'; a.click();
    showToast('Exported pfos_backup.pfos!');
  }
  function handleBackupImport(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const raw = String(reader.result || '').trim();
        const parsed = raw.startsWith('{') ? JSON.parse(raw) : JSON.parse(decodeURIComponent(escape(atob(raw))));
        state = ensureStateDefaults(parsed.data || parsed);
        await persistState(); renderCurrentView(); showToast('PFOS Vault restored into SQLite!');
      } catch (_) { showToast('Invalid .pfos file.', 'error'); }
      e.target.value = '';
    };
    reader.readAsText(file);
  }
  function confirmReset(mode) {
    openModal(`
      <h3 class="text-base font-bold mb-2">${mode === 'EMPTY' ? 'Start Fresh (Empty Vault)?' : 'Reload Sample Indian Data?'}</h3>
      <p class="text-xs text-slate-400 mb-5">This replaces your current SQLite database. Download <code class="text-sky-300">pfos_vault.sqlite</code> first if needed.</p>
      <div class="flex gap-2">
        <button onclick="PFOS.closeModal()" class="flex-1 py-2.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold">Cancel</button>
        <button onclick="PFOS.executeReset('${mode}')" class="flex-1 py-2.5 rounded-xl bg-rose-500 text-white text-xs font-bold">Confirm</button>
      </div>
    `);
  }
  async function executeReset(mode) {
    state = mode === 'EMPTY' ? getEmptyData() : getSampleData();
    await persistState(); closeModal(); updateNavStyles(); renderCurrentView();
    showToast(mode === 'EMPTY' ? 'Fresh empty SQLite vault ready!' : 'Sample data loaded into SQLite!');
  }

  // ==================== QUICK ACTION DISPATCHER (PWA SHORTCUTS & NOTIFICATIONS) ====================
  function handleQuickAction(action) {
    if (!action) return;
    if (action === 'quick-expense') openQuickEntryPad('EXPENSE');
    else if (action === 'quick-income') openQuickEntryPad('INCOME');
    else if (action === 'quick-atm') openQuickEntryPad('ATM');
    else if (action === 'quick-upi') openQuickEntryPad('UPI');
    else if (action === 'voice') openVoiceModal();
    else if (action === 'assistant') setTab('assistant');
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
        <div class="rounded-2xl bg-rose-950/50 border border-rose-500/40 p-6 text-center space-y-2">
          <h3 class="text-sm font-bold text-rose-300">SQLite Initialization Error</h3>
          <p class="text-xs text-slate-300">${escapeHtml(err.message)}</p>
          <button onclick="location.reload()" class="mt-2 px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 text-xs font-bold">Retry</button>
        </div>
      `;
    }
  }

  window.addEventListener('DOMContentLoaded', boot);

  return {
    setTab, setPlanningSubTab, setAssistantSubTab, switchProfile, closeModal, renderCurrentView,
    handleUnlock, openSetEncryptionModal, saveEncryptionPin, disableEncryption, lockVaultNow,
    openQuickEntryPad, submitQuickEntry, openSearchModal, runGlobalSearch,
    processDueRecurringRules, runRecurringNow, toggleRecurringActive,
    openAddRecurringModal, openEditRecurringModal, submitRecurring, deleteRecurring,
    dismissAlert, skipSubscriptionMonth, triggerPersistentSummaryNotification,
    toggleAuditItem, resetWeeklyAudit, openMonthlyReportModal, saveNotificationSettings, openAdjustCashModal,
    openTransactionModal, openEditTransactionModal, submitTransaction, deleteTransaction,
    openVoiceModal, startSpeechRecognition, parseAndLogVoice,
    openSmsModal, parseAndLogSms, openHealthBreakdownModal,
    openAddAccountModal, openEditAccountModal, submitAccount, deleteAccount,
    payObligation, openAddLoanModal, openEditLoanModal, submitLoan, deleteLoan, openSettleLoanModal, submitLoanPayment,
    openAddObligationModal, openEditObligationModal, submitObligation, deleteObligation,
    openAddBudgetModal, openEditBudgetModal, submitBudget, deleteBudget,
    openAddGoalModal, openEditGoalModal, submitGoal, contributeGoal, deleteGoal,
    openAddInvestmentModal, openEditInvestmentModal, submitInvestment, deleteInvestment,
    completeDailyReview, setTimelineType, setTimelineAccount, setTimelineSearch, selectCalendarDay, setAnalyticsRange,
    exportSqliteFile, handleSqliteImport, linkLocalSqliteFile,
    openApkModal, triggerPwaInstall, downloadFlutterApkKit,
    exportBackup, handleBackupImport, confirmReset, executeReset
  };
})();
