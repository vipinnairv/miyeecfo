
/* ══════════════════════════════════════
   FINANCIAL ENGINE: single source of truth
   Every page derives its numbers from here so that
   "Net Worth" means exactly one thing app-wide.
══════════════════════════════════════ */
const monthKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

/* ── Investment instrument valuation ──────────────────────────────
   Unit-based holdings are worth what the market says today: units held
   times the latest price you enter. Everything else (RD/FD/PPF) has no
   quoted price, so it falls back to a modelled compound growth.
   New types (Equity, Crypto) join the unit-based family. Their "NAV" is
   just a share or coin price; enter it in your own reporting currency. */
/* One colour map for instrument types, shared by every screen that badges them.
   It used to be copy-pasted per page and drifted when new types were added. */
const INSTR_COLOR={'SIP':'var(--g)','Mutual Fund':'var(--b)','Equity (India)':'var(--b)','Equity (US)':'var(--p)','Crypto':'var(--o)','RD':'var(--t)','FD':'var(--o)','PPF':'var(--p)'};
const INSTR_BG={'SIP':'var(--gl)','Mutual Fund':'var(--bl)','Equity (India)':'var(--bl)','Equity (US)':'var(--pl)','Crypto':'var(--ol)','RD':'var(--tl)','FD':'var(--ol)','PPF':'var(--pl)'};
const UNIT_TYPES=['SIP','Mutual Fund','Equity (India)','Equity (US)','Crypto'];
const isUnitType=t=>UNIT_TYPES.includes(t);
// What the price field is called for a given type.
const priceLabel=t=>(t==='SIP'||t==='Mutual Fund')?'NAV':'Price';
const unitLabel=t=>t==='Crypto'?'Coins':(t==='Equity (India)'||t==='Equity (US)')?'Shares':'Units';
// Latest price on file for an instrument, if any.
const instrPrice=i=>i&&(i.currentNAV||i.lastBuyNAV)||0;
/* Value of one instrument's logged contributions as of today.
   Preference order:
     1. unit-based with a latest price and units held → units × latest price
     2. otherwise → each contribution compounded from its own date at the
        instrument's modelled return rate.
   Returns {value, invested, units, priced} so callers can show which basis
   was used. */
function instrValueFromTxs(instr,txs){
  const invested=txs.reduce((s,t)=>s+(t.amount||0),0);
  // Units come only from what you actually logged as contributions. A plan's
  // "units held" field never creates value on its own, so an instrument you have
  // not funded is worth nothing here.
  const units=txs.reduce((s,t)=>s+(t.units||0),0);
  const px=instrPrice(instr);
  if(instr&&isUnitType(instr.type)&&px>0&&units>0){
    return{value:units*px,invested,units,priced:true};
  }
  const r=(instr&&instr.returnRate||0)/100/12,now=Date.now();
  const value=txs.reduce((sum,t)=>{
    const mo=Math.max(0,(now-new Date(t.date).getTime())/(86400000*30.44));
    return sum+(t.amount||0)*(r>0?Math.pow(1+r,mo):1);
  },0);
  return{value,invested,units,priced:false};
}

/* What a goal has actually saved: the sum of its logged contributions.
   Storing a running total drifted permanently, because deleting a contribution
   never reversed it. Deriving it means the figure can never disagree with the
   log. */
function goalSaved(goal,investmentTxs){
  if(!goal)return 0;
  const ids=new Set((goal.instruments||[]).map(i=>i.id));
  return (investmentTxs||[]).reduce((s,t)=>
    s+((t.goalId===goal.id||ids.has(t.instrumentId))?(t.amount||0):0),0);
}

/* XIRR: the money-weighted annual return that discounts every dated cashflow
   back to zero. Contributions are outflows (negative), today's value is one
   inflow (positive). Solved by bisection, which always converges for a normal
   invest-then-value profile. Returns a percentage, or null when it cannot be
   defined (no flows, no time elapsed, or no sign change). */
function xirr(flows){
  if(!flows||flows.length<2)return null;
  const t0=Math.min(...flows.map(f=>+new Date(f.date)));
  const yrs=f=>(+new Date(f.date)-t0)/(365*86400000);
  const hasPos=flows.some(f=>f.amount>0),hasNeg=flows.some(f=>f.amount<0);
  if(!hasPos||!hasNeg)return null;
  const npv=rate=>flows.reduce((s,f)=>s+f.amount/Math.pow(1+rate,yrs(f)),0);
  let lo=-0.9999,hi=100;
  if(npv(lo)*npv(hi)>0)return null;
  for(let i=0;i<200;i++){
    const mid=(lo+hi)/2,v=npv(mid);
    if(Math.abs(v)<1e-6)return mid*100;
    (npv(lo)*v<0?hi=mid:lo=mid);
  }
  return (lo+hi)/2*100;
}
// XIRR from a set of contributions plus the value they are worth today.
const xirrFromTxs=(txs,valueToday)=>{
  if(!txs.length||valueToday<=0)return null;
  const flows=txs.map(t=>({amount:-(t.amount||0),date:t.date}));
  flows.push({amount:valueToday,date:new Date().toISOString().slice(0,10)});
  return xirr(flows);
};

function computeFin(data,months){
  const {transactions=[],accounts=[],creditCards=[],loans=[],budgetLimits={},expenseCategories=[],investmentTxs=[],goals=[]}=data;

  // ── Balance sheet ──
  const bankBal=accounts.filter(a=>a.type==='bank').reduce((s,a)=>s+a.balance,0);
  const cashBal=accounts.filter(a=>a.type==='cash'||a.type==='wallet').reduce((s,a)=>s+a.balance,0);
  const fdBal=accounts.filter(a=>a.type==='fd').reduce((s,a)=>s+a.balance,0);
  const liquid=bankBal+cashBal;
  const assets=liquid+fdBal;
  const ccPay=creditCards.reduce((s,c)=>s+c.payable,0);
  const ccProv=creditCards.reduce((s,c)=>s+c.provision,0);
  const ccLiab=ccPay+ccProv;
  const totalLimit=creditCards.reduce((s,c)=>s+c.limit,0);
  const ccUtil=totalLimit>0?ccLiab/totalLimit*100:0;
  const loanOS=loans.reduce((s,l)=>s+l.outstanding,0);
  const provTotal=(data.provisions||[]).filter(p=>!p.paid).reduce((s,p)=>s+p.amount,0);
  const liabilities=ccLiab+loanOS+provTotal;
  // Liquid assets only, net of every liability. Investments are deliberately absent:
  // this is the figure the runway and fund-balance cards are built on.
  const liquidNetWorth=assets-liabilities;

  // ── Period flows (single pass; months lookup is a Set) ──
  const mSet=new Set(months.map(m=>m.key));
  const periodTxs=transactions.filter(t=>mSet.has(t.month));
  let totalInc=0,totalExp=0,emiPrincipalPaid=0,emiInterestPaid=0,emiCashOut=0;
  const incByMonth={},expByMonth={},catMap={},merchantMap={},merchantCnt={},pmMap={};
  for(const t of periodTxs){
    if(t.type==='income'){totalInc+=t.amount;incByMonth[t.month]=(incByMonth[t.month]||0)+t.amount;}
    else if(t.type==='expense'){
      totalExp+=t.amount;expByMonth[t.month]=(expByMonth[t.month]||0)+t.amount;
      catMap[t.category]=(catMap[t.category]||0)+t.amount;
      if(t.merchant){merchantMap[t.merchant]=(merchantMap[t.merchant]||0)+t.amount;merchantCnt[t.merchant]=(merchantCnt[t.merchant]||0)+1;}
      const pm=t.paymentMode||'Unknown';pmMap[pm]=(pmMap[pm]||0)+t.amount;
    }
    else if(t.type==='emi'){
      // A loan EMI splits in two. The interest is a genuine cost and belongs in
      // expenses; the principal repays debt, so it is a transfer that moves cash
      // without being a cost. Only the interest lands in the P&L.
      const int_=t.interest||0;
      if(int_>0){
        totalExp+=int_;expByMonth[t.month]=(expByMonth[t.month]||0)+int_;
        catMap['Loan Interest']=(catMap['Loan Interest']||0)+int_;
        const pm=t.paymentMode||'Unknown';pmMap[pm]=(pmMap[pm]||0)+int_;
      }
      emiPrincipalPaid+=(t.principal||0);emiInterestPaid+=int_;emiCashOut+=(t.amount||0);
    }
  }
  const surplus=totalInc-totalExp;
  const savingsRate=totalInc>0?surplus/totalInc*100:0;
  const mInc=months.map(m=>incByMonth[m.key]||0);
  const mExp=months.map(m=>expByMonth[m.key]||0);

  // ── Investments ──────────────────────────────────────────────
  // Money you put into an instrument is not spending, so it never touches `totalExp`.
  // It leaves your cash though, which is why the P&L waterfall carries on past the
  // surplus:  Income − Expense = Surplus − Investments = Balance Cash.
  // The same money does not vanish. It reappears on the balance sheet as `invCorpus`,
  // grown from each contribution's own date at its instrument's rate, and lands in
  // net worth as an asset.
  const instrById={};
  for(const g of goals)for(const i of (g.instruments||[]))instrById[i.id]=i;
  const invMonthOf=t=>t.month||(t.date||'').slice(0,7);
  const invByMonth={};
  let invTotal=0,invPeriod=0,invCorpus=0;
  const txsByInstr={};
  for(const t of investmentTxs){
    const amt=t.amount||0;
    invTotal+=amt;
    const k=invMonthOf(t);
    if(mSet.has(k)){invPeriod+=amt;invByMonth[k]=(invByMonth[k]||0)+amt;}
    (txsByInstr[t.instrumentId||'?']=txsByInstr[t.instrumentId||'?']||[]).push(t);
  }
  // Value only instruments you have actually funded (a logged contribution).
  // See instrValueFromTxs for the exact rule.
  for(const id in txsByInstr)invCorpus+=instrValueFromTxs(instrById[id],txsByInstr[id]).value;
  const invGain=invCorpus-invTotal;
  const mInv=months.map(m=>invByMonth[m.key]||0);
  // What is genuinely left over once the money you committed to investing is set aside.
  const cashBalance=surplus-invPeriod;
  const investRate=totalInc>0?invPeriod/totalInc*100:0;
  // THE canonical figure. Liquid net worth plus what your investments are worth today.
  const netWorth=liquidNetWorth+invCorpus;

  // ── Elapsed basis ── how much of the period has actually happened.
  // Everything time-normalised (budgets, averages) MUST use this, never months.length,
  // otherwise part-year spend gets compared against a full-year allowance.
  const nowKey=monthKey(new Date());
  const elapsedMonths=Math.min(months.length,Math.max(1,months.filter(m=>m.key<=nowKey).length));
  const startDate=months.length?new Date(months[0].key+'-01'):new Date();
  const [ey,em]=(months.length?months[months.length-1].key:nowKey).split('-').map(Number);
  const endDate=new Date(ey,em,0); // last day of final month
  const effectiveDate=new Date(Math.min(Date.now(),endDate.getTime()));
  const daysElapsed=Math.max(1,Math.round((effectiveDate-startDate)/86400000));
  const avgDailyBurn=totalExp/daysElapsed;
  const avgMonthlyInc=totalInc/daysElapsed*30;
  const avgMonthlyExp=totalExp/daysElapsed*30;
  const cashSurplus=avgMonthlyInc-avgMonthlyExp;

  // ── Budget, pro-rated to elapsed months ──
  const budgetMonthly=expenseCategories.reduce((s,c)=>s+(budgetLimits[c]||0),0);
  const budgetToDate=budgetMonthly*elapsedMonths;   // fair comparison vs totalExp
  const budgetFullPeriod=budgetMonthly*months.length; // informational only
  const budgetPct=budgetToDate>0?totalExp/budgetToDate*100:0;

  // ── Liability tenure classification (the 12-month rule) ──
  // A liability is SHORT TERM if it falls due within the next 12 months.
  //  · Credit cards  are always short term by nature
  //  · Overdraft     is a bank account with a negative balance; already inside `liquid`
  //  · Loans         are short term only when they finish inside the window
  //  · Expected future outflows are short term when their expected month is inside it
  const horizon=new Date();horizon.setMonth(horizon.getMonth()+12);
  const horizonKey=`${horizon.getFullYear()}-${String(horizon.getMonth()+1).padStart(2,'0')}`;
  const isShortTermLoan=l=>{
    if(!l.endDate)return false;                    // open-ended → treat as long term
    const end=new Date(l.endDate);
    return isFinite(end)&&end<=horizon;
  };
  const shortTermLoans=loans.filter(isShortTermLoan);
  const longTermLoans=loans.filter(l=>!isShortTermLoan(l));
  const shortTermLoanOS=shortTermLoans.reduce((s,l)=>s+(l.outstanding||0),0);
  const longTermLoanOS=longTermLoans.reduce((s,l)=>s+(l.outstanding||0),0);
  // Overdrafts, broken out for display only. They already reduce `bankBal`.
  const odBal=Math.abs(accounts.filter(a=>a.type==='bank'&&a.balance<0).reduce((s,a)=>s+a.balance,0));
  // Expected future outflows landing inside the window
  const provShortTerm=(data.provisions||[]).filter(p=>!p.paid&&(p.month||'')<=horizonKey).reduce((s,p)=>s+p.amount,0);
  const shortTermLiab=ccLiab+shortTermLoanOS+provShortTerm;
  // THE figure: what your funds cover once only near-term obligations are netted off.
  // Long-term loan principal is deliberately excluded. It is not due yet.
  const fundBalExclLTL=assets-shortTermLiab;
  // For context: the slice of long-term debt that *is* payable in the next 12 months.
  const ltCurrentPortion=longTermLoans.reduce((s,l)=>s+Math.min((l.emi||0)*12,l.outstanding||0),0);

  // ── Loans ──
  const totalEmi=loans.reduce((s,l)=>s+(l.emi||0),0);
  const monthlyInterestCost=loans.reduce((s,l)=>s+(l.outstanding||0)*((l.roi||0)/100/12),0);
  const monthlyPrincipalRepaid=Math.max(0,totalEmi-monthlyInterestCost);
  const monthlyNWGrowth=cashSurplus+monthlyPrincipalRepaid;
  const emiRatio=avgMonthlyInc>0?totalEmi/avgMonthlyInc*100:0;

  // ── Runway ──
  const burnRate=avgDailyBurn*30;
  const liquidRunway=burnRate>0?liquid/burnRate:99;
  const fundRunway=burnRate>0?assets/burnRate:99;

  // ── Month-over-month deltas (last two COMPLETE months) ──
  const completed=months.filter(m=>m.key<nowKey);
  const lastM=completed[completed.length-1],prevM=completed[completed.length-2];
  const mom=(map)=>{
    if(!lastM||!prevM)return null;
    const cur=map[lastM.key]||0,prv=map[prevM.key]||0;
    if(prv===0)return null;
    return{pct:(cur-prv)/Math.abs(prv)*100,cur,prv,label:lastM.label};
  };
  const momInc=mom(incByMonth),momExp=mom(expByMonth);

  return{
    bankBal,cashBal,fdBal,liquid,assets,ccPay,ccProv,ccLiab,totalLimit,ccUtil,
    loanOS,provTotal,liabilities,netWorth,liquidNetWorth,
    invTotal,invPeriod,invCorpus,invGain,mInv,cashBalance,investRate,
    shortTermLoans,longTermLoans,shortTermLoanOS,longTermLoanOS,odBal,
    provShortTerm,shortTermLiab,fundBalExclLTL,ltCurrentPortion,
    periodTxs,totalInc,totalExp,surplus,savingsRate,mInc,mExp,
    emiPrincipalPaid,emiInterestPaid,emiCashOut,
    catMap,merchantMap,merchantCnt,pmMap,
    elapsedMonths,daysElapsed,avgDailyBurn,burnRate,avgMonthlyInc,avgMonthlyExp,cashSurplus,
    budgetMonthly,budgetToDate,budgetFullPeriod,budgetPct,
    totalEmi,monthlyInterestCost,monthlyPrincipalRepaid,monthlyNWGrowth,emiRatio,
    liquidRunway,fundRunway,momInc,momExp,
  };
}
// Memoised so a keystroke elsewhere doesn't re-run every reduce on the dashboard.

/* ══════════════════════════════════════
   RECONCILIATION ENGINE
   Answers one question: does the money you have recorded moving
   agree with the balances you say you hold?

     Opening + Money In − Money Out = Expected Closing
     Expected Closing vs Actual Balance = the difference to explain

   Transactions carry a payment mode, not an account id, so the check runs
   per FUND TYPE (bank / cash / wallet) rather than per account. Fixed
   deposits are excluded. They move by maturity and transfer, not by
   day-to-day spending, so folding them in would only add noise.
══════════════════════════════════════ */

// Which pot a payment mode draws on. Credit Card is deliberately absent:
// spending on a card creates a liability, it does not move your own cash
// until the bill is paid.
const FUND_OF_MODE={
  'NEFT/Bank Transfer':'bank',
  'UPI':'bank',
  'Debit Card':'bank',
  'Cash':'cash',
  'Wallet':'wallet',
};
const FUND_BUCKETS=[
  {key:'bank',  label:'Bank',          types:['bank'],   modes:['NEFT/Bank Transfer','UPI','Debit Card']},
  {key:'cash',  label:'Cash In Hand',  types:['cash'],   modes:['Cash']},
  {key:'wallet',label:'Digital Wallet',types:['wallet'], modes:['Wallet']},
];

function computeReconciliation(data,months){
  const {accounts=[],transactions=[],investmentTxs=[]}=data;
  const mSet=new Set(months.map(m=>m.key));
  const monthOf=t=>t.month||(t.date||'').slice(0,7);

  const blank=()=>({inflow:0,outflow:0,invested:0,inCount:0,outCount:0,invCount:0,byMode:{}});
  const mv={};FUND_BUCKETS.forEach(b=>{mv[b.key]=blank();});
  // Movements that never touch your own funds, tracked so the page can say so.
  let ccSpend=0,ccCount=0,ccPaid=0,emiPaid=0;
  // Anything whose payment mode is missing or unrecognised: the reason a
  // reconciliation fails to balance more often than not.
  const unclassified=[];
  let unclassifiedIn=0,unclassifiedOut=0;

  const note=(bucket,kind,mode,amt)=>{
    const m=mv[bucket];if(!m)return;
    m.byMode[mode]=m.byMode[mode]||{in:0,out:0,inv:0};
    m.byMode[mode][kind]+=amt;
  };

  for(const t of transactions){
    if(!mSet.has(monthOf(t)))continue;
    const amt=t.amount||0;
    // Self-transfer: money leaves one fund and lands in another. Net zero
    // across your funds, but each bucket must see its side of the move.
    if(t.type==='transfer'){
      const fb=FUND_OF_MODE[t.paymentMode||''],tb=FUND_OF_MODE[t.transferTo||''];
      if(fb){mv[fb].outflow+=amt;mv[fb].outCount++;note(fb,'out','Transfer out',amt);}
      if(tb){mv[tb].inflow+=amt;mv[tb].inCount++;note(tb,'in','Transfer in',amt);}
      if(!fb&&!tb){unclassified.push({...t,why:'Transfer with no recognised fund on either side'});}
      continue;
    }
    // Credit card bill payment: real money leaves a fund to clear the card.
    // It is never an expense, because the original card spend already was one.
    if(t.type==='cardpay'){
      const fb=FUND_OF_MODE[t.paymentMode||''];
      if(fb){mv[fb].outflow+=amt;mv[fb].outCount++;note(fb,'out','Card bill payment',amt);}
      else unclassified.push({...t,why:'Card bill payment with no recognised fund'});
      ccPaid+=amt;
      continue;
    }
    // A loan EMI takes the whole instalment out of the fund it is paid from.
    if(t.type==='emi'){
      const fb=FUND_OF_MODE[t.paymentMode||''];
      if(fb){mv[fb].outflow+=amt;mv[fb].outCount++;note(fb,'out','Loan EMI',amt);}
      else unclassified.push({...t,why:'Loan EMI with no recognised fund'});
      emiPaid+=amt;
      continue;
    }
    if(t.type!=='income'&&t.type!=='expense')continue;
    const mode=t.paymentMode||'';
    if(mode==='Credit Card'){
      // A card spend hits the card, not your cash. Income on a card is not a
      // real thing, so only expenses are counted here.
      if(t.type==='expense'){ccSpend+=amt;ccCount++;}
      else{unclassified.push({...t,why:'Income marked as paid by credit card'});unclassifiedIn+=amt;}
      continue;
    }
    const bucket=FUND_OF_MODE[mode];
    if(!bucket){
      unclassified.push({...t,why:mode?`Unrecognised payment mode "${mode}"`:'No payment mode recorded'});
      if(t.type==='income')unclassifiedIn+=amt;else unclassifiedOut+=amt;
      continue;
    }
    const m=mv[bucket];
    if(t.type==='income'){m.inflow+=amt;m.inCount++;note(bucket,'in',mode,amt);}
    else{m.outflow+=amt;m.outCount++;note(bucket,'out',mode,amt);}
  }

  // Investment contributions leave the fund they were paid from.
  for(const t of investmentTxs){
    if(!mSet.has(monthOf(t)))continue;
    const amt=t.amount||0;
    const mode=t.paymentMode||'NEFT/Bank Transfer';
    const bucket=FUND_OF_MODE[mode];
    if(!bucket){
      unclassified.push({...t,type:'investment',category:'Investment contribution',
        why:mode?`Unrecognised payment mode "${mode}"`:'No payment mode recorded'});
      unclassifiedOut+=amt;continue;
    }
    mv[bucket].invested+=amt;mv[bucket].invCount++;note(bucket,'inv',mode,amt);
  }

  // ── Per-bucket reconciliation ──
  const rows=FUND_BUCKETS.map(b=>{
    const accs=accounts.filter(a=>b.types.includes(a.type));
    const actual=accs.reduce((s,a)=>s+(a.balance||0),0);
    const m=mv[b.key];
    const net=m.inflow-m.outflow-m.invested;
    // A bucket is reconcilable as soon as ANY account in it has an opening.
    // Accounts without one are counted as opening zero, which is stated in the
    // UI, because silently skipping the whole bucket hides real gaps: a single
    // unset opening on a tiny account used to mask a large discrepancy.
    const withOpening=accs.filter(a=>a.opening!==null&&a.opening!==undefined);
    const accountsWithout=accs.filter(a=>a.opening===null||a.opening===undefined);
    const openingSet=accs.length>0&&withOpening.length>0;
    const fullyCovered=accs.length>0&&accountsWithout.length===0;
    const opening=withOpening.reduce((s,a)=>s+(a.opening||0),0);
    // With no opening on file at all, the ledger still says what it must have been.
    const impliedOpening=actual-net;
    const expected=opening+net;
    const diff=actual-expected;
    return{...b,accounts:accs,actual,opening,openingSet,fullyCovered,impliedOpening,net,expected,diff,
      partialOpening:withOpening.length>0&&accountsWithout.length>0,
      accountsWithout,...m};
  });

  const tracked=rows.filter(r=>r.accounts.length>0);
  const totals={
    actual:tracked.reduce((s,r)=>s+r.actual,0),
    opening:tracked.reduce((s,r)=>s+r.opening,0),
    inflow:tracked.reduce((s,r)=>s+r.inflow,0),
    outflow:tracked.reduce((s,r)=>s+r.outflow,0),
    invested:tracked.reduce((s,r)=>s+r.invested,0),
    net:tracked.reduce((s,r)=>s+r.net,0),
  };
  // Only buckets with an opening on file can produce a meaningful difference.
  const reconcilable=tracked.filter(r=>r.openingSet);
  totals.reconcilable=reconcilable.length;
  totals.tracked=tracked.length;
  totals.allChecked=tracked.length>0&&tracked.every(r=>r.fullyCovered);
  totals.assumedZero=tracked.reduce((s,r)=>s+r.accountsWithout.length,0);
  // A second set of totals over the checked buckets alone. The verdict is stated in
  // these, so every term of `opening + in − out − invested = expected vs actual`
  // covers the same funds and the sum actually holds.
  const sum=(rs,k)=>rs.reduce((s,r)=>s+r[k],0);
  const checked={
    opening:sum(reconcilable,'opening'),inflow:sum(reconcilable,'inflow'),
    outflow:sum(reconcilable,'outflow'),invested:sum(reconcilable,'invested'),
    expected:sum(reconcilable,'expected'),actual:sum(reconcilable,'actual'),
    diff:sum(reconcilable,'diff'),
  };
  totals.expected=checked.expected;
  totals.diff=checked.diff;

  // A rupee or two of rounding is not a discrepancy worth chasing.
  const TOL=1;
  const balanced=reconcilable.length>0&&Math.abs(totals.diff)<=TOL;
  const fdBal=accounts.filter(a=>a.type==='fd').reduce((s,a)=>s+(a.balance||0),0);

  return{rows,tracked,totals,checked,balanced,tolerance:TOL,
    unclassified,unclassifiedIn,unclassifiedOut,
    ccSpend,ccCount,ccPaid,emiPaid,fdBal,
    hasOpenings:reconcilable.length>0};
}

/* Node test hook. In the browser `module` is undefined, so this is skipped and
   the file behaves as a plain concatenated script. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={INSTR_COLOR,INSTR_BG,computeFin,computeReconciliation,instrValueFromTxs,xirr,xirrFromTxs,goalSaved,
    isUnitType,instrPrice,monthKey,FUND_OF_MODE,FUND_BUCKETS,UNIT_TYPES};
}
