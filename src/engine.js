
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
   CFO ENGINE
   Five questions a finance app usually leaves you to work out yourself.
   All pure functions of `data`, so the UI can run them on a hypothetical
   copy just as easily as on your real books.
══════════════════════════════════════ */

// Assumed yields when you have not entered one. Deliberately conservative:
// overstating what an asset earns would hide a negative carry, which is the
// one thing this analysis exists to find.
const DEFAULT_YIELD={fd:7,bank:3,cash:0,wallet:0};

/* ── 1. NEGATIVE CARRY ──────────────────────────────────────────────
   Money that earns less than your debt costs is money you are paying to
   keep. Holding a deposit at 7% against a loan at 12.36% is not caution,
   it is a 5.36% annual fee for the comfort of a bigger balance. This ranks
   every asset against every debt and prices the overlap. */
function computeCarry(data){
  const {accounts=[],loans=[],creditCards=[]}=data;
  const assets=accounts
    .filter(a=>(a.balance||0)>0)
    .map(a=>({id:a.id,name:a.name,type:a.type,amount:a.balance,
      rate:a.rate===null||a.rate===undefined||a.rate===''?(DEFAULT_YIELD[a.type]||0):+a.rate,
      assumed:a.rate===null||a.rate===undefined||a.rate===''}))
    .sort((x,y)=>x.rate-y.rate);   // cheapest money to redeploy first
  // Overdrafts are debt wearing an account's clothes. Rate unknown, so they
  // are listed but never priced, rather than silently valued at zero.
  const overdrafts=accounts.filter(a=>(a.balance||0)<0)
    .map(a=>({id:a.id,name:a.name,amount:-a.balance}));
  const debts=loans.filter(l=>(l.outstanding||0)>0)
    .map(l=>({id:l.id,name:`${l.bank} ${l.type}`,amount:l.outstanding,rate:+l.roi||0,kind:'loan'}))
    .sort((x,y)=>y.rate-x.rate);   // most expensive debt killed first

  const liquidAssets=assets.reduce((s,a)=>s+a.amount,0);
  const totalDebt=debts.reduce((s,d)=>s+d.amount,0);

  // Greedy match: cheapest-yielding rupee against dearest debt. That pairing
  // maximises the spread, so it is the best case available to you.
  const pool=assets.map(a=>({...a,left:a.amount}));
  const pairs=[];let annualGain=0,deployed=0;
  for(const d of debts){
    let need=d.amount;
    for(const a of pool){
      if(need<=0)break;
      if(a.left<=0||a.rate>=d.rate)continue;   // no spread, no gain
      const use=Math.min(a.left,need);
      const spread=d.rate-a.rate;
      const gain=use*spread/100;
      pairs.push({from:a.name,fromRate:a.rate,assumed:a.assumed,to:d.name,toRate:d.rate,
        amount:use,spread:+spread.toFixed(2),annualGain:Math.round(gain)});
      a.left-=use;need-=use;annualGain+=gain;deployed+=use;
    }
  }
  const idle=pool.reduce((s,a)=>s+a.left,0);
  // Credit limit you are not using. Not an asset, but it is liquidity you can
  // reach in a day, which changes how much cash you need to sit on.
  const unusedCredit=creditCards.reduce((s,c)=>s+Math.max(0,(c.limit||0)-(c.payable||0)-(c.provision||0)),0);

  return{assets,debts,overdrafts,pairs,
    annualGain:Math.round(annualGain),monthlyGain:Math.round(annualGain/12),
    deployed,idle,liquidAssets,totalDebt,unusedCredit,
    worthDoing:annualGain>=1000};
}

/* ── 2. SURVIVAL TIMELINE ───────────────────────────────────────────
   "Runway: 8 months" assumes one undifferentiated pot. Real money runs out
   in an order: spending cash, then current accounts, then deposits you have
   to break. This walks the calendar forward and dates each of those. */
function survivalTimeline(data,fin,opts){
  const o=opts||{};
  const monthlyIn=o.monthlyIncome!==undefined?o.monthlyIncome:(fin.avgMonthlyInc||0);
  const monthlyOut=(o.monthlyExpense!==undefined?o.monthlyExpense:(fin.avgMonthlyExp||0))+(fin.totalEmi||0);
  const net=monthlyIn-monthlyOut;
  const {accounts=[]}=data;
  // Liquidation order: what you would actually spend first.
  const rank={cash:0,wallet:1,bank:2,fd:3};
  const tiers=accounts.filter(a=>(a.balance||0)>0)
    .map(a=>({name:a.name,type:a.type,amount:a.balance,rank:rank[a.type]===undefined?2:rank[a.type]}))
    .sort((x,y)=>x.rank-y.rank||x.amount-y.amount);
  const total=tiers.reduce((s,t)=>s+t.amount,0);

  const events=[];
  if(net>=0)return{net,monthlyIn,monthlyOut,total,events,monthsLeft:Infinity,solvent:true};

  const burn=-net;const start=new Date();let spent=0;
  for(const t of tiers){
    spent+=t.amount;
    const months=spent/burn;
    const d=new Date(start);d.setMonth(d.getMonth()+Math.floor(months));
    events.push({name:t.name,type:t.type,amount:t.amount,
      monthsOut:+months.toFixed(1),date:d.toISOString().slice(0,10),
      cumulative:spent});
  }
  return{net,monthlyIn,monthlyOut,burn,total,events,
    monthsLeft:+(total/burn).toFixed(1),
    zeroDate:events.length?events[events.length-1].date:null,
    solvent:false};
}

/* ── 3. GOAL REALITY ────────────────────────────────────────────────
   A progress bar creeping from 0.2% to 0.3% is a lie of omission. This
   inverts the arithmetic: at what you actually contribute, when do you
   arrive, and what would it take to arrive on time. */
function goalReality(goal,txs,nowRef){
  const saved=goalSaved(goal,txs);
  const target=+goal.targetAmount||0;
  const mine=(txs||[]).filter(t=>t.goalId===goal.id);
  // Actual run rate, measured from your own contributions rather than from
  // the amount you once said you would invest.
  const dates=mine.map(t=>t.date).filter(Boolean).sort();
  const monthsSeen=[...new Set(mine.map(t=>t.month||(t.date||'').slice(0,7)))].filter(Boolean);
  // One contribution in one month is not a run rate. Dividing by a single
  // month would read a lump sum as a monthly habit and call a hopeless goal
  // comfortably on track, which is exactly the flattery this is meant to end.
  const enoughHistory=monthsSeen.length>=2;
  let monthsActive=1;
  if(dates.length>1){
    const a=new Date(dates[0]),b=new Date(dates[dates.length-1]);
    monthsActive=Math.max(1,(b.getFullYear()-a.getFullYear())*12+(b.getMonth()-a.getMonth())+1);
  }
  const actualMonthly=enoughHistory?mine.reduce((s,t)=>s+(t.amount||0),0)/monthsActive:0;
  const rate=(goal.instruments||[]).length
    ? (goal.instruments.reduce((s,i)=>s+(+i.returnRate||0),0)/goal.instruments.length)
    : 0;
  const r=rate/100/12;
  const gap=Math.max(0,target-saved);
  const now=nowRef||new Date();
  const targetDate=goal.targetDate?new Date(goal.targetDate):null;
  const monthsToTarget=targetDate&&isFinite(targetDate)
    ? Math.max(0,(targetDate.getFullYear()-now.getFullYear())*12+(targetDate.getMonth()-now.getMonth()))
    : null;

  // Monthly contribution needed to close the gap by the target date, given
  // compounding. Falls back to plain division at a zero return rate.
  let requiredMonthly=null;
  if(monthsToTarget&&monthsToTarget>0){
    const grown=saved*Math.pow(1+r,monthsToTarget);
    const need=Math.max(0,target-grown);
    requiredMonthly=r>0?need*r/(Math.pow(1+r,monthsToTarget)-1):need/monthsToTarget;
    requiredMonthly=Math.round(requiredMonthly);
  }
  // At your real pace, how long until you get there.
  let monthsAtCurrent=null;
  if(enoughHistory&&actualMonthly>0&&gap>0){
    if(r>0){
      const num=Math.log((target*r+actualMonthly)/(saved*r+actualMonthly));
      monthsAtCurrent=num>0?Math.round(num/Math.log(1+r)):0;
    }else monthsAtCurrent=Math.round(gap/actualMonthly);
  }
  const arrivalYear=monthsAtCurrent!==null&&isFinite(monthsAtCurrent)
    ? now.getFullYear()+Math.floor((now.getMonth()+monthsAtCurrent)/12) : null;
  const shortfall=requiredMonthly!==null?Math.round(requiredMonthly-actualMonthly):null;

  return{saved,target,gap,pct:target>0?saved/target*100:0,
    actualMonthly:Math.round(actualMonthly),rate,requiredMonthly,shortfall,
    monthsToTarget,monthsAtCurrent,arrivalYear,enoughHistory,contributions:mine.length,
    onTrack:enoughHistory&&requiredMonthly!==null&&actualMonthly>=requiredMonthly,
    stalled:enoughHistory&&actualMonthly<=0&&gap>0};
}

/* ── 4. RECURRING RADAR ─────────────────────────────────────────────
   Subscriptions do not announce themselves; they just show up every month
   at roughly the same price. This finds them in the ledger you already
   have, and prices them per YEAR, because people decide differently about
   "₹750" than about "₹9,000 a year". */
function detectRecurring(transactions,opts){
  const o=opts||{};
  const minHits=o.minHits||3;
  const byMerchant={};
  for(const t of (transactions||[])){
    if(t.type!=='expense')continue;
    const key=(t.merchant||'').trim();
    if(!key||key.toUpperCase()==='NA')continue;   // unlabelled, nothing to learn
    (byMerchant[key]=byMerchant[key]||[]).push(t);
  }
  const found=[];
  for(const name in byMerchant){
    const txs=byMerchant[name].slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    if(txs.length<minHits)continue;
    const months=[...new Set(txs.map(t=>t.month||(t.date||'').slice(0,7)))].sort();
    if(months.length<minHits)continue;            // three charges in one month is a habit, not a subscription
    const amts=txs.map(t=>t.amount||0);
    const total=amts.reduce((s,x)=>s+x,0);
    const avg=total/amts.length;
    const spread=Math.max(...amts)-Math.min(...amts);
    // A steady price every month is a subscription. A bill that arrives every
    // month for a different amount (electricity, gas) is just as committed but
    // cannot be cancelled the same way, so it is labelled apart from both.
    const steady=avg>0&&spread/avg<=0.25;
    // Consecutive months is the other subscription tell.
    let consecutive=1,best=1;
    for(let i=1;i<months.length;i++){
      const [y1,m1]=months[i-1].split('-').map(Number),[y2,m2]=months[i].split('-').map(Number);
      if((y2-y1)*12+(m2-m1)===1){consecutive++;best=Math.max(best,consecutive);}else consecutive=1;
    }
    found.push({merchant:name,count:txs.length,months:months.length,monthsRun:best,
      avg:Math.round(avg),total,annual:Math.round(avg*12),
      category:txs[txs.length-1].category||'',
      paymentMode:txs[txs.length-1].paymentMode||'',
      kind:steady&&best>=minHits?'subscription':(best>=minHits?'variable':(steady?'regular':'habit')),
      steady,lastDate:txs[txs.length-1].date});
  }
  found.sort((a,b)=>b.annual-a.annual);
  const subs=found.filter(f=>f.kind==='subscription');
  const variable=found.filter(f=>f.kind==='variable');
  return{found,subscriptions:subs,variable,habits:found.filter(f=>f.kind==='habit'),
    // Everything that arrives every month whether you decide on it or not.
    annualCommitted:subs.concat(variable).reduce((s,f)=>s+f.annual,0),
    annualSubscriptions:subs.reduce((s,f)=>s+f.annual,0)};
}

/* ── 5. INTEGRITY ───────────────────────────────────────────────────
   Every money bug in this app has had one shape: a stored running total
   drifting from the entries that are supposed to add up to it. Rather than
   trust them, recompute each one and report the difference. A number that
   can be checked stops being able to lie quietly. */
function integrityCheck(data){
  const {goals=[],investmentTxs=[],loans=[],transactions=[],accounts=[]}=data;
  const issues=[];
  for(const g of goals){
    const derived=goalSaved(g,investmentTxs);
    const stored=+g.currentAmount||0;
    if(Math.abs(derived-stored)>1)
      issues.push({kind:'goal',name:g.name,stored,derived,diff:stored-derived,fixable:true,
        detail:'Saved amount does not match its logged contributions.'});
  }
  for(const l of loans){
    // Only a BROKEN LINK is drift. Instalments recorded before the ledger
    // existed carry no txId and are simply history, not corruption: counting
    // them would cry wolf on every older book and, worse, offer a repair that
    // cannot repair them.
    const linked=(l.paidEmis||[]).filter(p=>p.txId);
    const txIds=new Set(transactions.filter(t=>t.type==='emi').map(t=>t.id));
    const dangling=linked.filter(p=>!txIds.has(p.txId)).length;
    if(dangling)
      issues.push({kind:'loan',name:`${l.bank} ${l.type}`,stored:linked.length,derived:linked.length-dangling,
        diff:dangling,fixable:true,
        detail:'Instalments marked paid whose ledger entry has been deleted.'});
    const emiTx=transactions.filter(t=>t.type==='emi'&&t.loanId===l.id);
    const paidTxIds=new Set((l.paidEmis||[]).map(p=>p.txId).filter(Boolean));
    const stray=emiTx.filter(t=>!paidTxIds.has(t.id)).length;
    if(stray&&linked.length)
      issues.push({kind:'loan',name:`${l.bank} ${l.type}`,stored:emiTx.length,derived:emiTx.length-stray,
        diff:stray,fixable:false,
        detail:'Ledger entries for instalments the loan no longer lists as paid.'});
  }
  // Entries pointing at something that no longer exists.
  const accIds=new Set(accounts.map(a=>a.id));
  const orphanTx=transactions.filter(t=>t.accountId&&!accIds.has(t.accountId)).length;
  if(orphanTx)issues.push({kind:'orphan',name:'Transactions',stored:orphanTx,derived:0,diff:orphanTx,fixable:true,
    detail:'Entries reference an account that has been deleted.'});
  const goalIds=new Set(goals.map(g=>g.id));
  const orphanInv=investmentTxs.filter(t=>t.goalId&&!goalIds.has(t.goalId)).length;
  if(orphanInv)issues.push({kind:'orphan',name:'Contributions',stored:orphanInv,derived:0,diff:orphanInv,fixable:true,
    detail:'Contributions reference a goal that has been deleted.'});

  const checked=goals.length+loans.length+2;
  return{issues,clean:issues.length===0,checked,
    // Only claim a repair when one exists. An unfixable finding is still worth
    // showing; offering a button that cannot help would be worse than silence.
    fixable:issues.filter(i=>i.fixable).length,
    score:checked>0?Math.round((checked-issues.length)/checked*100):100};
}

/* ── 6. SCENARIOS ───────────────────────────────────────────────────
   computeFin is a pure function of `data`, so a hypothetical costs nothing
   more than a copy. This is the whole "what if" feature: mutate a clone,
   run the same engine, diff the answers. No separate projection code to
   drift out of step with the real one. */
function applyScenario(data,sc){
  const d=JSON.parse(JSON.stringify(data));
  if(!sc)return d;
  if(sc.prepay&&sc.prepay.amount>0){
    const amt=+sc.prepay.amount;
    const loan=d.loans.find(l=>l.id===sc.prepay.loanId)||d.loans[0];
    const acct=d.accounts.find(a=>a.id===sc.prepay.accountId)||d.accounts.find(a=>a.balance>=amt);
    if(loan)loan.outstanding=Math.max(0,loan.outstanding-amt);
    if(acct)acct.balance-=amt;
  }
  if(sc.incomeDelta)for(const t of d.transactions)if(t.type==='income')t.amount+=sc.incomeDelta;
  if(sc.expenseDelta){
    // Spread proportionally so one category does not absorb the whole change.
    const exp=d.transactions.filter(t=>t.type==='expense');
    const tot=exp.reduce((s,t)=>s+t.amount,0);
    if(tot>0)for(const t of exp)t.amount=Math.max(0,t.amount+sc.expenseDelta*(t.amount/tot));
  }
  if(sc.extraSip&&sc.extraSip>0&&d.goals.length){
    const g=d.goals.find(x=>x.id===sc.goalId)||d.goals[0];
    const inst=(g.instruments||[])[0];
    if(inst)d.investmentTxs.push({id:'sc_'+Math.random().toString(36).slice(2),
      goalId:g.id,instrumentId:inst.id,amount:sc.extraSip,
      date:new Date().toISOString().slice(0,10),month:monthKey(new Date()),
      paymentMode:'NEFT/Bank Transfer',units:0});
  }
  return d;
}

// What changed, and did it help. Signed so the UI never has to guess.
function scenarioDiff(base,alt){
  const keys=['netWorth','liquidNetWorth','totalExp','surplus','cashBalance',
    'liabilities','loanOS','totalEmi','monthlyInterestCost','liquidRunway','fundRunway'];
  const out={};
  for(const k of keys)out[k]={base:base[k],alt:alt[k],delta:(alt[k]||0)-(base[k]||0)};
  return out;
}

/* Node test hook. In the browser `module` is undefined, so this is skipped and
   the file behaves as a plain concatenated script. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={INSTR_COLOR,INSTR_BG,computeFin,instrValueFromTxs,xirr,xirrFromTxs,goalSaved,
    isUnitType,instrPrice,monthKey,UNIT_TYPES,
    computeCarry,survivalTimeline,goalReality,detectRecurring,integrityCheck,
    applyScenario,scenarioDiff,DEFAULT_YIELD};
}
