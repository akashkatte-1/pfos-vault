/**
 * PFOS — Personal Financial Operating System (Application Controller)
 * Powered by PFOS_DB (db-engine.js) for encrypted OPFS/IndexedDB SQLite persistence.
 */
const PFOS = (() => {
  let state = null;
  let pendingEncryptedBlob = null;
  let activeTab = 'home';
  let planningSubTab = 'loans';
  let timelineFilter = { type: 'ALL', accountId: 'ALL', search: '' };
  let analyticsRange = 'MONTHLY';
  let calendarDate = new Date();
  let selectedCalendarDay = new Date().getDate();
  let chartInstances = {};
  let deferredPwaPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
  });

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

  // ==================== DEFAULT DATA SEEDS ====================
  function getSampleData() {
    const currDay = new Date().getDate();
    return {
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [daysAgoISO(1), daysAgoISO(2), daysAgoISO(3)], missedPayments90d: 0 },
      accounts: [
        { id: 'acc_sbi', profile: 'PERSONAL', type: 'BANK', name: 'SBI Savings', bankName: 'State Bank of India', masked: '4821', ifsc: 'SBIN0001420', balance: 48500, notes: 'Salary account' },
        { id: 'acc_hdfc', profile: 'PERSONAL', type: 'BANK', name: 'HDFC Savings', bankName: 'HDFC Bank', masked: '9014', ifsc: 'HDFC0000240', balance: 34200, notes: 'Primary UPI & Bills' },
        { id: 'acc_biz', profile: 'BUSINESS', type: 'BANK', name: 'ICICI Freelance', bankName: 'ICICI Bank', masked: '3319', ifsc: 'ICIC0000104', balance: 22000, notes: 'Client retainers' },
        { id: 'acc_cash', profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Physical Cash', masked: '', balance: 6850, notes: 'Daily wallet cash' },
        { id: 'acc_emg_cash', profile: 'FAMILY', type: 'CASH', name: 'Home Emergency Cash', bankName: 'Home Safe', masked: '', balance: 15000, notes: 'Emergency reserve' },
        { id: 'acc_gpay', profile: 'PERSONAL', type: 'WALLET', name: 'GPay UPI Lite', bankName: 'Google Pay', masked: 'okhdfc', balance: 1850, notes: 'Small daily spends' },
        { id: 'acc_phonepe', profile: 'PERSONAL', type: 'WALLET', name: 'PhonePe Wallet', bankName: 'PhonePe', masked: 'ybl', balance: 950, notes: 'Recharges & fast UPI' },
        { id: 'acc_cc_hdfc', profile: 'PERSONAL', type: 'CREDIT_CARD', name: 'HDFC Millennia CC', bankName: 'HDFC Bank', masked: '6672', balance: 14200, creditLimit: 60000, statementDay: 15, dueDay: Math.min(28, currDay + 5), minDue: 1420, annualFee: 1000, notes: 'Online card' },
        { id: 'acc_cc_icici', profile: 'PERSONAL', type: 'CREDIT_CARD', name: 'Amazon Pay ICICI CC', bankName: 'ICICI Bank', masked: '1108', balance: 4800, creditLimit: 50000, statementDay: 10, dueDay: Math.min(28, currDay + 10), minDue: 480, annualFee: 0, notes: 'Lifetime free' },
        { id: 'acc_dc_sbi', profile: 'PERSONAL', type: 'DEBIT_CARD', name: 'SBI Global Debit', bankName: 'State Bank of India', masked: '7741', linkedBank: 'SBI Savings', expiry: '08/29', balance: 0, notes: 'ATM' }
      ],
      transactions: [
        { id: 'tx_1', profile: 'PERSONAL', type: 'INCOME', amount: 65000, accountId: 'acc_sbi', category: 'Salary', method: 'NETBANKING', merchant: 'TechCorp India Pvt Ltd', date: daysAgoISO(12), time: '09:05', source: 'SMS', notes: 'Monthly Salary' },
        { id: 'tx_2', profile: 'BUSINESS', type: 'INCOME', amount: 18000, accountId: 'acc_biz', category: 'Freelancing', method: 'UPI', upiApp: 'GPay', upiId: 'client@okicici', refNumber: '431298451209', merchant: 'UI Design Sprint', date: daysAgoISO(6), time: '16:20', source: 'MANUAL', notes: 'Milestone 1' },
        { id: 'tx_3', profile: 'PERSONAL', type: 'TRANSFER', amount: 10000, accountId: 'acc_hdfc', toAccountId: 'acc_cash', category: 'ATM Withdrawal', method: 'CARD', merchant: 'HDFC ATM Cash Withdrawal', date: daysAgoISO(5), time: '12:15', source: 'SMS', isAtm: true, notes: 'ATM cash' },
        { id: 'tx_4', profile: 'PERSONAL', type: 'EXPENSE', amount: 350, accountId: 'acc_gpay', category: 'Food', method: 'UPI', upiApp: 'GPay', upiId: 'swiggy@icici', refNumber: '431987112233', merchant: 'Swiggy Dinner', date: daysAgoISO(3), time: '20:40', source: 'NOTIFICATION', notes: 'Dinner' },
        { id: 'tx_5', profile: 'PERSONAL', type: 'EXPENSE', amount: 1200, accountId: 'acc_cash', category: 'Food', method: 'CASH', merchant: 'Local Vegetable & Grocery', date: daysAgoISO(3), time: '18:10', source: 'MANUAL', notes: 'Weekly veggies' },
        { id: 'tx_6', profile: 'PERSONAL', type: 'EXPENSE', amount: 1500, accountId: 'acc_hdfc', category: 'Fuel', method: 'UPI', upiApp: 'PhonePe', upiId: 'hpcl@ybl', refNumber: '432011998877', merchant: 'HPCL Petrol Pump', date: daysAgoISO(2), time: '10:30', source: 'SMS', notes: 'Petrol' },
        { id: 'tx_7', profile: 'PERSONAL', type: 'EXPENSE', amount: 1950, accountId: 'acc_cash', category: 'Transport', method: 'CASH', merchant: 'Auto, Parking & Snacks', date: daysAgoISO(1), time: '19:00', source: 'VOICE', notes: 'Commute' },
        { id: 'tx_8', profile: 'PERSONAL', type: 'EXPENSE', amount: 2499, accountId: 'acc_cc_hdfc', category: 'Shopping', method: 'CARD', merchant: 'Amazon India', date: daysAgoISO(1), time: '21:15', source: 'SMS', notes: 'Headphones' },
        { id: 'tx_9', profile: 'PERSONAL', type: 'EXPENSE', amount: 180, accountId: 'acc_gpay', category: 'Food', method: 'UPI', upiApp: 'GPay', upiId: 'chai@okaxis', refNumber: '432155667788', merchant: 'Lunch & Filter Coffee', date: todayISO(), time: '13:15', source: 'MANUAL', notes: 'Office canteen' }
      ],
      loans: [
        { id: 'ln_1', profile: 'PERSONAL', direction: 'LENT', person: 'Rahul Sharma', principal: 10000, outstanding: 10000, interest: 0, dueDate: daysAgoISO(-15), notes: 'Emergency help' },
        { id: 'ln_2', profile: 'FAMILY', direction: 'BORROWED', person: 'Vikram (Cousin)', principal: 8000, outstanding: 4500, interest: 0, dueDate: daysAgoISO(-10), notes: 'Trip split' }
      ],
      obligations: [
        { id: 'ob_1', profile: 'PERSONAL', kind: 'EMI', title: 'Royal Enfield Bike EMI', amount: 5200, dueDay: 5, remainingMonths: 14, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_2', profile: 'FAMILY', kind: 'RENT', title: 'House Rent (2BHK)', amount: 12000, dueDay: 1, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: true },
        { id: 'ob_3', profile: 'FAMILY', kind: 'BILL', title: 'MSEB Electricity Bill', amount: 1850, dueDay: 18, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_4', profile: 'PERSONAL', kind: 'BILL', title: 'JioFiber Broadband', amount: 999, dueDay: 22, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_5', profile: 'PERSONAL', kind: 'SUBSCRIPTION', title: 'Netflix Standard', amount: 499, dueDay: 24, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_6', profile: 'PERSONAL', kind: 'SUBSCRIPTION', title: 'Spotify & YouTube Premium', amount: 268, dueDay: 26, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false },
        { id: 'ob_7', profile: 'FAMILY', kind: 'INSURANCE', title: 'Term Life Insurance', amount: 1450, dueDay: 28, remainingMonths: null, frequency: 'MONTHLY', paidThisMonth: false }
      ],
      budgets: [
        { id: 'bg_1', profile: 'PERSONAL', category: 'Food', limit: 5000 },
        { id: 'bg_2', profile: 'PERSONAL', category: 'Fuel', limit: 3000 },
        { id: 'bg_3', profile: 'PERSONAL', category: 'Shopping', limit: 4000 },
        { id: 'bg_4', profile: 'PERSONAL', category: 'Transport', limit: 2500 }
      ],
      goals: [
        { id: 'gl_1', profile: 'PERSONAL', title: 'Emergency Fund (6 Months)', target: 150000, saved: 98000, targetDate: '2027-03-31' },
        { id: 'gl_2', profile: 'PERSONAL', title: 'Work Laptop', target: 110000, saved: 42000, targetDate: '2027-06-30' },
        { id: 'gl_3', profile: 'FAMILY', title: 'Goa Family Vacation', target: 45000, saved: 28500, targetDate: '2026-12-25' }
      ],
      investments: [
        { id: 'inv_1', profile: 'PERSONAL', assetType: 'SIP', name: 'Nifty 50 Index Direct SIP', invested: 60000, currentValue: 74500, updated: todayISO() },
        { id: 'inv_2', profile: 'PERSONAL', assetType: 'FD', name: 'SBI Fixed Deposit (7.1%)', invested: 50000, currentValue: 53550, updated: todayISO() },
        { id: 'inv_3', profile: 'FAMILY', assetType: 'GOLD', name: 'Sovereign Gold Bond / Gold', invested: 25000, currentValue: 31200, updated: todayISO() },
        { id: 'inv_4', profile: 'PERSONAL', assetType: 'PPF', name: 'Public Provident Fund', invested: 45000, currentValue: 49800, updated: todayISO() }
      ],
      netWorthHistory: [
        { label: 'Jun', value: 224000 }, { label: 'Jul', value: 241500 }, { label: 'Aug', value: 258000 },
        { label: 'Sep', value: 272400 }, { label: 'Oct', value: 295800 }, { label: 'Nov', value: 314900 }
      ]
    };
  }

  function getEmptyData() {
    return {
      activeProfile: 'ALL',
      reconciliation: { dailyReviewDates: [], missedPayments90d: 0 },
      accounts: [
        { id: uid('acc'), profile: 'PERSONAL', type: 'BANK', name: 'Primary Bank Account', bankName: 'SBI / HDFC', masked: '0000', ifsc: '', balance: 0, notes: '' },
        { id: uid('acc'), profile: 'PERSONAL', type: 'CASH', name: 'Cash in Hand', bankName: 'Physical Cash', masked: '', balance: 0, notes: '' }
      ],
      transactions: [], loans: [], obligations: [],
      budgets: [{ id: uid('bg'), profile: 'PERSONAL', category: 'Food', limit: 5000 }],
      goals: [], investments: [], netWorthHistory: [{ label: 'Now', value: 0 }]
    };
  }

  async function persistState() {
    try {
      await PFOS_DB.saveState(state);
      updateDbStatusUI();
    } catch (err) {
      showToast('SQLite write error: ' + err.message, 'error');
    }
  }

  function updateDbStatusUI() {
    const stats = PFOS_DB.getStats();
    const el = document.getElementById('sidebar-sqlite-status');
    if (el) {
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span> SQLite • ${stats.sizeKB} KB ${stats.encrypted ? '🔒' : ''}`;
    }
    const lockBtn = document.getElementById('header-lock-btn');
    if (lockBtn) {
      lockBtn.classList.toggle('hidden', !stats.encrypted);
    }
  }

  function byProfile(list) {
    if (!state || state.activeProfile === 'ALL') return list;
    return list.filter((item) => item.profile === state.activeProfile);
  }

  // ==================== FINANCIAL ENGINE ====================
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
    const upcomingBillsRent = unpaidObligations.filter(o => ['BILL', 'RENT', 'INSURANCE'].includes(o.kind)).reduce((s, o) => s + Number(o.amount || 0), 0);
    const upcomingSubs = unpaidObligations.filter(o => o.kind === 'SUBSCRIPTION').reduce((s, o) => s + Number(o.amount || 0), 0);

    const borrowedDue = loans.filter(l => l.direction === 'BORROWED' && l.outstanding > 0).reduce((s, l) => s + Number(l.outstanding || 0), 0);
    const lentOutstanding = loans.filter(l => l.direction === 'LENT' && l.outstanding > 0).reduce((s, l) => s + Number(l.outstanding || 0), 0);

    const totalObligations = creditCardDues + upcomingEmis + upcomingBillsRent + upcomingSubs + borrowedDue;
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

    return {
      bankBalance, cashBalance, walletBalance, liquidAssets, investmentsValue, totalAssets,
      creditCardDues, totalCreditLimit, creditUtilization,
      upcomingEmis, upcomingBillsRent, upcomingSubs, borrowedDue, lentOutstanding,
      totalObligations, trueFreeMoney, commitmentRatio, risk, netWorth,
      monthlyIncome, monthlyExpenses, todaySpending,
      emergencyRequired, emergencySaved, emergencyPct,
      healthScore, healthBreakdown: { savingsPts, creditPts, emergencyPts, debtPts, disciplinePts, savingsRate: Math.round(savingsRate * 100) },
      atmWithdrawn, cashExpensesLogged, unaccountedCash, reviewedToday, completenessScore
    };
  }

  // ==================== NAVIGATION & RENDERING ====================
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
    showToast(`Switched to ${profile === 'ALL' ? 'All Profiles' : profile} view`, 'info');
  }
  function updateNavStyles() {
    const titles = {
      home: 'Money Commitments', accounts: 'Accounts & Cards', timeline: 'Unified Timeline',
      planning: 'Obligations & Planning', analytics: 'Analytics & Net Worth', settings: 'SQLite Vault, Encryption & APK'
    };
    document.getElementById('header-title').textContent = titles[activeTab] || 'PFOS';
    document.querySelectorAll('.nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `nav-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
        active ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25' : 'text-slate-400 hover:bg-card hover:text-slate-200 border border-transparent'
      }`;
    });
    document.querySelectorAll('.m-nav-btn').forEach(btn => {
      const active = btn.dataset.tab === activeTab;
      btn.className = `m-nav-btn flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-xl text-[10px] font-medium transition ${
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
    else if (activeTab === 'analytics') {
      container.innerHTML = renderAnalyticsTab();
      setTimeout(initAnalyticsCharts, 40);
    }
    else if (activeTab === 'settings') container.innerHTML = renderSettingsTab();
    refreshIcons();
  }

  // ==================== TAB 1: HOME ====================
  function renderHomeTab() {
    const m = computeMetrics();
    const recentTxs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).slice(0, 5);
    const upcomingObs = byProfile(state.obligations).filter(o => !o.paidThisMonth).sort((a, b) => a.dueDay - b.dueDay).slice(0, 4);

    return `
      <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-card to-slate-900 border border-slate-800 p-5 sm:p-6 shadow-2xl">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <p class="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-1.5">
              <i data-lucide="sparkles" class="w-3.5 h-3.5 text-emerald-400"></i> Flagship Money Commitments
            </p>
            <p class="text-[11px] text-slate-500 mt-0.5">True Free Money = Total Assets − All Upcoming Obligations</p>
          </div>
          <span class="px-3 py-1 rounded-full text-xs font-bold border ${m.risk.badgeClass}">
            ${m.risk.label} • ${Math.round(m.commitmentRatio)}% Committed
          </span>
        </div>
        <div class="mb-5">
          <p class="text-xs text-slate-400">True Free Money Available</p>
          <div class="text-3xl sm:text-4xl font-extrabold tracking-tight mt-1 ${m.trueFreeMoney >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatINR(m.trueFreeMoney)}</div>
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
              <div class="flex justify-between"><span>Banks</span><span class="text-slate-200">${formatINR(m.bankBalance)}</span></div>
              <div class="flex justify-between"><span>Cash</span><span class="text-slate-200">${formatINR(m.cashBalance)}</span></div>
              <div class="flex justify-between"><span>Wallets</span><span class="text-slate-200">${formatINR(m.walletBalance)}</span></div>
              <div class="flex justify-between"><span>Invested</span><span class="text-slate-200">${formatINR(m.investmentsValue)}</span></div>
            </div>
          </div>
          <div class="rounded-2xl bg-obsidian/70 border border-slate-800/90 p-3.5">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-rose-400">Total Obligations</span>
              <span class="text-base font-bold text-slate-100">${formatINR(m.totalObligations)}</span>
            </div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <div class="flex justify-between"><span>Card Dues</span><span class="text-slate-200">${formatINR(m.creditCardDues)}</span></div>
              <div class="flex justify-between"><span>EMIs</span><span class="text-slate-200">${formatINR(m.upcomingEmis)}</span></div>
              <div class="flex justify-between"><span>Bills/Rent</span><span class="text-slate-200">${formatINR(m.upcomingBillsRent + m.upcomingSubs)}</span></div>
              <div class="flex justify-between"><span>Borrowed</span><span class="text-slate-200">${formatINR(m.borrowedDue)}</span></div>
            </div>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        <button onclick="PFOS.openTransactionModal('EXPENSE')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-bold transition active:scale-95"><i data-lucide="minus-circle" class="w-4 h-4"></i> + Expense</button>
        <button onclick="PFOS.openTransactionModal('INCOME')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold transition active:scale-95"><i data-lucide="plus-circle" class="w-4 h-4"></i> + Income</button>
        <button onclick="PFOS.openTransactionModal('TRANSFER')" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 text-xs font-bold transition active:scale-95"><i data-lucide="arrow-left-right" class="w-4 h-4"></i> ATM / Transfer</button>
        <button onclick="PFOS.openVoiceModal()" class="flex items-center justify-center gap-2 p-3 rounded-2xl bg-violet-500/15 hover:bg-violet-500/25 border border-violet-500/30 text-violet-300 text-xs font-bold transition active:scale-95"><i data-lucide="mic" class="w-4 h-4"></i> Voice Entry</button>
        <button onclick="PFOS.openSmsModal()" class="col-span-2 sm:col-span-1 flex items-center justify-center gap-2 p-3 rounded-2xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-bold transition active:scale-95"><i data-lucide="message-square-code" class="w-4 h-4"></i> SMS Parser</button>
      </section>

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
          <p class="text-[10px] text-slate-400">6× Exp Target: ${formatINR(m.emergencyRequired)}</p>
        </div>
        <div onclick="PFOS.setTab('timeline')" class="cursor-pointer rounded-2xl bg-card hover:bg-slate-800/80 border border-slate-800 p-4 transition">
          <div class="flex items-center justify-between text-slate-400 text-xs mb-1.5"><span>Completeness</span><i data-lucide="check-circle-2" class="w-4 h-4 text-teal-400"></i></div>
          <div class="text-xl font-extrabold text-teal-400">${m.completenessScore}%</div>
          <p class="text-[11px] text-slate-400 mt-1">${m.unaccountedCash > 0 ? `${formatINR(m.unaccountedCash)} cash gap` : 'Cash reconciled ✓'}</p>
        </div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold">Recent Activity</h3>
            <button onclick="PFOS.setTab('timeline')" class="text-xs text-emerald-400 hover:underline">View All</button>
          </div>
          <div class="space-y-2.5">
            ${recentTxs.length ? recentTxs.map(t => renderTxRow(t, true)).join('') : '<p class="text-xs text-slate-500 py-6 text-center">No transactions yet.</p>'}
          </div>
        </div>
        <div class="rounded-2xl bg-card border border-slate-800 p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold">Upcoming Dues & EMIs</h3>
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
          <h3 class="text-base font-bold">Accounts, Wallets & Cards</h3>
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

  // ==================== TAB 3: TIMELINE ====================
  function renderTimelineTab() {
    const m = computeMetrics();
    const accounts = byProfile(state.accounts);
    let txs = byProfile(state.transactions).slice().sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
    if (timelineFilter.type !== 'ALL') txs = txs.filter(t => t.type === timelineFilter.type);
    if (timelineFilter.accountId !== 'ALL') txs = txs.filter(t => t.accountId === timelineFilter.accountId || t.toAccountId === timelineFilter.accountId);
    if (timelineFilter.search.trim()) {
      const q = timelineFilter.search.toLowerCase();
      txs = txs.filter(t => (t.merchant || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q) || (t.upiId || '').toLowerCase().includes(q));
    }

    return `
      <section class="rounded-2xl bg-gradient-to-r from-amber-500/10 via-card to-teal-500/10 border border-amber-500/25 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <i data-lucide="radar" class="w-4 h-4 text-amber-400"></i>
            <h3 class="text-xs font-bold uppercase tracking-wider text-amber-300">Missing Expense & Cash Reconciliation</h3>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-300">${m.completenessScore}% Complete</span>
          </div>
          <p class="text-xs text-slate-300">
            ATM Withdrawn: <strong>${formatINR(m.atmWithdrawn)}</strong> • Cash Logged: <strong>${formatINR(m.cashExpensesLogged)}</strong>
            ${m.unaccountedCash > 0 ? ` • <span class="text-amber-400 font-bold">${formatINR(m.unaccountedCash)} cash remains unaccounted</span>` : ' • <span class="text-emerald-400 font-semibold">All ATM cash accounted for!</span>'}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          ${m.unaccountedCash > 0 ? `<button onclick="PFOS.openTransactionModal('EXPENSE', 'acc_cash')" class="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-bold transition">+ Log Cash Spend</button>` : ''}
          <button onclick="PFOS.completeDailyReview()" class="px-3 py-2 rounded-xl ${m.reviewedToday ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'} text-xs font-bold transition">${m.reviewedToday ? '✓ Daily Review Done' : 'Complete Daily Review'}</button>
        </div>
      </section>

      <section class="flex flex-col sm:flex-row gap-2.5">
        <div class="relative flex-1">
          <i data-lucide="search" class="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2"></i>
          <input type="text" value="${escapeHtml(timelineFilter.search)}" oninput="PFOS.setTimelineSearch(this.value)" placeholder="Search merchant, UPI ID, category, notes..." class="w-full bg-card border border-slate-800 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500" />
        </div>
        <div class="flex gap-2 overflow-x-auto no-scrollbar">
          ${['ALL', 'EXPENSE', 'INCOME', 'TRANSFER'].map(tp => `<button onclick="PFOS.setTimelineType('${tp}')" class="px-3.5 py-2 rounded-xl text-xs font-semibold shrink-0 border transition ${timelineFilter.type === tp ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-card border-slate-800 text-slate-400 hover:text-slate-200'}">${tp === 'ALL' ? 'All' : tp.charAt(0) + tp.slice(1).toLowerCase()}</button>`).join('')}
          <select onchange="PFOS.setTimelineAccount(this.value)" class="bg-card border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300">
            <option value="ALL">All Accounts</option>
            ${accounts.map(a => `<option value="${a.id}" ${timelineFilter.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </section>

      <section class="rounded-2xl bg-card border border-slate-800 p-4 space-y-2.5">
        ${txs.length ? txs.map(t => renderTxRow(t, true)).join('') : '<p class="text-xs text-slate-500 text-center py-10">No matching transactions found.</p>'}
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
            <p class="text-xs font-bold text-slate-100 truncate">${escapeHtml(t.merchant || t.category)}</p>
            <p class="text-[11px] text-slate-400 truncate">${escapeHtml(t.date)} ${t.time ? `• ${escapeHtml(t.time)}` : ''} • ${escapeHtml(acc ? acc.name : 'Account')}${toAcc ? ` → ${escapeHtml(toAcc.name)}` : ''}</p>
            <div class="flex flex-wrap gap-1.5 mt-1">
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">${escapeHtml(t.category || t.type)}</span>
              ${t.source && t.source !== 'MANUAL' ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">${escapeHtml(t.source)}</span>` : ''}
              ${t.upiApp ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">${escapeHtml(t.upiApp)}${t.refNumber ? ` #${escapeHtml(t.refNumber.slice(-4))}` : ''}</span>` : ''}
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

  // ==================== TAB 4: PLANNING ====================
  function renderPlanningTab() {
    const subTabs = [
      { id: 'loans', label: 'Loans & EMIs' },
      { id: 'bills', label: 'Bills, Subs & Calendar' },
      { id: 'budgets', label: 'Budgets & Goals' },
      { id: 'investments', label: 'Investments' }
    ];
    let body = '';
    if (planningSubTab === 'loans') body = renderLoansEmisSubTab();
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

  function renderLoansEmisSubTab() {
    const loans = byProfile(state.loans), emis = byProfile(state.obligations).filter(o => o.kind === 'EMI');
    return `
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="rounded-2xl bg-card border border-slate-800 p-4 space-y-4">
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Loans (Lent & Borrowed)</h3><button onclick="PFOS.openAddLoanModal()" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-xs font-bold">+ Add Loan</button></div>
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
          <div class="flex items-center justify-between"><h3 class="text-sm font-bold">Bills, Rent & Subscriptions</h3><button onclick="PFOS.openAddObligationModal('BILL')" class="px-3 py-1.5 rounded-xl bg-emerald-500/15 text-emerald-400 text-xs font-bold">+ Add Bill / Sub</button></div>
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

  // ==================== TAB 5: ANALYTICS ====================
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

  // ==================== TAB 6: SQLITE VAULT, ENCRYPTION & APK ====================
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
          <div class="flex items-center justify-between">
            <div><h3 class="text-sm font-bold flex items-center gap-2"><i data-lucide="shield" class="w-4 h-4 text-emerald-400"></i> AES-256-GCM Vault Encryption</h3><p class="text-xs text-slate-400 mt-0.5">Encrypts the binary SQLite file on disk with your PIN</p></div>
          </div>
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
          <div><h3 class="text-base font-extrabold text-slate-100">Install on Android / Download APK Kit</h3><p class="text-xs text-slate-300 mt-1">Install this PWA from Chrome or compile the native Android APK:</p></div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">INSTANT PWA</span><h4 class="text-sm font-bold mt-2">1. Install via Chrome</h4><p class="text-[11px] text-slate-400 mt-1">Offline Service Worker + persistent OPFS SQLite vault.</p></div>
            <button onclick="PFOS.triggerPwaInstall()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Install App</button>
          </div>
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300">NATIVE APK</span><h4 class="text-sm font-bold mt-2">2. Flutter APK Builder (.zip)</h4><p class="text-[11px] text-slate-400 mt-1">Native Android SQLite + GitHub Actions auto-compiler.</p></div>
            <button onclick="PFOS.downloadFlutterApkKit()" class="w-full py-2.5 rounded-xl bg-sky-500 text-slate-950 font-bold text-xs">Download Kit (.zip)</button>
          </div>
          <div class="rounded-2xl bg-obsidian/80 border border-slate-800 p-4 flex flex-col justify-between gap-3">
            <div><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300">WRAPPER</span><h4 class="text-sm font-bold mt-2">3. PWABuilder APK</h4><p class="text-[11px] text-slate-400 mt-1">Turn your Vercel/Netlify URL into a signed Android APK.</p></div>
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

  // ==================== SQLITE & ENCRYPTION HANDLERS ====================
  function exportSqliteFile() {
    const raw = PFOS_DB.exportRawSqlite();
    if (!raw) return showToast('SQLite database not ready.', 'error');
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
        state = await PFOS_DB.importRawSqlite(new Uint8Array(reader.result));
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
      <p class="text-xs text-slate-400 mb-3">Your PIN derives a 256-bit AES key via PBKDF2 to encrypt <code>pfos_vault.sqlite</code> on disk. Remember your PIN — it cannot be recovered.</p>
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
    closeModal();
    updateNavStyles();
    renderCurrentView();
    showToast('SQLite Vault encrypted with AES-256-GCM 🔒');
  }

  async function disableEncryption() {
    await PFOS_DB.disableEncryption();
    updateNavStyles();
    renderCurrentView();
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
      state = PFOS_DB.loadState();
      document.getElementById('desktop-profile-select').value = state.activeProfile || 'ALL';
      document.getElementById('mobile-profile-select').value = state.activeProfile || 'ALL';
      updateNavStyles();
      renderCurrentView();
      showToast('SQLite Vault decrypted & unlocked!');
    } catch (_) {
      document.getElementById('unlock-error').textContent = 'Wrong PIN — decryption failed.';
    }
  }

  // ==================== FULL EDIT / ADD / DELETE CRUD ====================
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
      : ['Food', 'Fuel', 'Shopping', 'Transport', 'Rent', 'EMI', 'Bills', 'Health', 'Entertainment', 'Other'];
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

  // Accounts CRUD
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

  // Loans CRUD
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

  // Obligations CRUD
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

  // Budgets, Goals, Investments CRUD
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
      <p class="text-xs text-slate-400 mb-3">Say or type: <em>"Spent 250 on lunch"</em>, <em>"Received 1000 from Rahul"</em>, or <em>"ATM withdrawal 5000"</em>.</p>
      <button id="voice-mic-btn" onclick="PFOS.startSpeechRecognition()" class="w-full py-3 mb-3 rounded-xl bg-violet-500 text-slate-950 font-bold text-xs flex items-center justify-center gap-2"><i data-lucide="mic" class="w-4 h-4"></i> Tap to Speak</button>
      <textarea id="voice-input-text" rows="2" placeholder="Or type command here..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogVoice()" class="w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Parse & Log Transaction</button>
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
    else if (lower.includes('received') || lower.includes('salary') || lower.includes('income')) { type = 'INCOME'; accountId = bankAcc.id; category = 'Income'; method = 'UPI'; }
    else if (lower.includes('lunch') || lower.includes('tea') || lower.includes('food')) category = 'Food';
    else if (lower.includes('petrol') || lower.includes('fuel')) category = 'Fuel';
    const now = new Date();
    await addTransactionRecord({ id: uid('tx'), profile: 'PERSONAL', type, amount, accountId, toAccountId, category, merchant: text, method, date: todayISO(), time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`, source: 'VOICE', isAtm: type === 'TRANSFER' });
    closeModal(); showToast(`Voice logged: ${type} ${formatINR(amount)}`);
  }

  function openSmsModal() {
    openModal(`
      <div class="flex items-center justify-between mb-4"><h3 class="text-base font-bold flex items-center gap-2"><i data-lucide="message-square-code" class="w-5 h-5 text-amber-400"></i> Indian Bank & UPI SMS Parser</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <textarea id="sms-raw-input" rows="3" placeholder="Paste SBI/HDFC/ICICI/Axis/UPI SMS here..." class="w-full bg-obsidian border border-slate-700 rounded-xl p-3 text-xs text-slate-100 mb-3"></textarea>
      <button onclick="PFOS.parseAndLogSms()" class="w-full py-3 rounded-xl bg-amber-500 text-slate-950 font-bold text-xs">Extract & Auto-Log</button>
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
    if (!state.reconciliation.dailyReviewDates.includes(d)) { state.reconciliation.dailyReviewDates.push(d); await persistState(); renderCurrentView(); showToast('Daily Review logged!'); }
    else showToast('Already completed today ✓', 'info');
  }
  function setTimelineType(t) { timelineFilter.type = t; renderCurrentView(); }
  function setTimelineAccount(id) { timelineFilter.accountId = id; renderCurrentView(); }
  function setTimelineSearch(q) { timelineFilter.search = q; renderCurrentView(); }
  function selectCalendarDay(d) { selectedCalendarDay = d; renderCurrentView(); }
  function setAnalyticsRange(r) { analyticsRange = r; renderCurrentView(); }

  function openApkModal() {
    openModal(`
      <div class="flex items-center justify-between mb-3"><h3 class="text-base font-extrabold flex items-center gap-2"><i data-lucide="smartphone" class="w-5 h-5 text-emerald-400"></i> Get PFOS on Android</h3><button onclick="PFOS.closeModal()" class="p-1.5 text-slate-400"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <div class="space-y-3">
        <div class="p-3.5 rounded-2xl bg-obsidian border border-emerald-500/30">
          <h4 class="text-xs font-bold text-emerald-300 mb-1">1. Install via Chrome (Offline PWA + Encrypted SQLite)</h4>
          <p class="text-[11px] text-slate-400 mb-2">Runs offline forever with AES-256 encrypted OPFS SQLite storage.</p>
          <button onclick="PFOS.triggerPwaInstall()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Install App / Show Steps</button>
        </div>
        <div class="p-3.5 rounded-2xl bg-obsidian border border-sky-500/30">
          <h4 class="text-xs font-bold text-sky-300 mb-1">2. Download Native Android APK Builder (.zip)</h4>
          <p class="text-[11px] text-slate-400 mb-2">Writes physical <code>pfos_vault.sqlite</code> on Android storage + GitHub auto-build.</p>
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
        <li>Your encrypted SQLite database is persisted locally on your phone.</li>
      </ol>
      <button onclick="PFOS.closeModal()" class="w-full py-2.5 rounded-xl bg-emerald-500 text-slate-950 font-bold text-xs">Got It</button>
    `);
  }

  async function downloadFlutterApkKit() {
    if (typeof JSZip === 'undefined') return showToast('JSZip not loaded yet.', 'error');
    const zip = new JSZip();
    zip.file('README.md', '# PFOS Native Android APK Builder (SQLite)
Upload to GitHub -> Actions -> Build PFOS Android APK -> Download app-release.apk.');
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
description: Personal Financial Operating System - Offline SQLite
version: 1.0.0+1
environment:
  sdk: '>=3.4.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  sqflite: ^2.3.3+1
  path_provider: ^2.1.4
  path: ^1.9.0
flutter:
  uses-material-design: true
`);
    zip.file('lib/main.dart', `import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final dir = await getApplicationDocumentsDirectory();
  final dbPath = join(dir.path, 'pfos_vault.sqlite');
  final db = await openDatabase(dbPath, version: 1, onCreate: (database, version) async {
    await database.execute('CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, balance REAL);');
    await database.execute('CREATE TABLE transactions (id TEXT PRIMARY KEY, type TEXT, amount REAL, account_id TEXT, category TEXT, merchant TEXT, date TEXT);');
  });
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
        appBar: AppBar(title: const Text('PFOS SQLite Vault'), actions: [IconButton(icon: const Icon(Icons.download), onPressed: _exportToDownloads)]),
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
            await widget.db.insert('transactions', {'id': DateTime.now().millisecondsSinceEpoch.toString(), 'type': 'EXPENSE', 'amount': 250.0, 'account_id': 'cash', 'category': 'Food', 'merchant': 'Quick Entry', 'date': DateTime.now().toIso8601String()});
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
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify({ app: 'PFOS', version: '2.0', data: state }))));
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
        state = parsed.data || parsed;
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

  // ==================== BOOTSTRAP ====================
  async function boot() {
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
        state = PFOS_DB.loadState();
      }
      document.getElementById('desktop-profile-select').value = state.activeProfile || 'ALL';
      document.getElementById('mobile-profile-select').value = state.activeProfile || 'ALL';
      updateNavStyles();
      renderCurrentView();
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
    setTab, setPlanningSubTab, switchProfile, closeModal,
    handleUnlock, openSetEncryptionModal, saveEncryptionPin, disableEncryption, lockVaultNow,
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
