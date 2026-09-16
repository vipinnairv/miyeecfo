/* Tests for the pure financial engine. Run: npm test
   No framework: a tiny assert harness keeps the repo dependency-free. */
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const E=require('../src/engine.js');

let pass=0,fail=0;
const ok=(name,cond,detail='')=>{if(cond){pass++;}else{fail++;console.log(`  FAIL ${name}${detail?': '+detail:''}`);}};
const near=(a,b,t=1)=>Math.abs(a-b)<=t;
const MONTHS=[{key:'2026-04',label:'Apr-26'},{key:'2026-05',label:'May-26'},{key:'2026-06',label:'Jun-26'}];
const base=()=>({profile:{periodStart:'2026-04',periodEnd:'2026-06'},accounts:[],creditCards:[],loans:[],
  provisions:[],transactions:[],goals:[],investmentTxs:[],budgetLimits:{},expenseCategories:[]});

/* ── computeFin: net worth identity ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:100000,opening:100000},{id:'f',type:'fd',balance:50000}];
  d.creditCards=[{limit:10000,payable:3000,provision:1000}];
  d.loans=[{outstanding:20000,emi:1000,roi:12}];
  const f=E.computeFin(d,MONTHS);
  ok('netWorth = assets + investments - liabilities',
     near(f.netWorth,100000+50000+f.invCorpus-4000-20000),`got ${f.netWorth}`);
  ok('liquidNetWorth excludes investments',near(f.liquidNetWorth,126000),`got ${f.liquidNetWorth}`);
}

/* ── computeFin: income/expense/surplus/balance cash ── */
{
  const d=base();
  d.transactions=[
    {type:'income',amount:100000,month:'2026-04',date:'2026-04-01',paymentMode:'NEFT/Bank Transfer'},
    {type:'expense',amount:30000,month:'2026-04',date:'2026-04-05',paymentMode:'UPI',category:'Rent'},
  ];
  d.goals=[{id:'g',name:'G',instruments:[{id:'i',type:'SIP',returnRate:0,amount:0}]}];
  d.investmentTxs=[{instrumentId:'i',goalId:'g',amount:10000,month:'2026-04',date:'2026-04-10',paymentMode:'NEFT/Bank Transfer'}];
  const f=E.computeFin(d,MONTHS);
  ok('surplus = income - expense',f.surplus===70000,`got ${f.surplus}`);
  ok('balanceCash = surplus - invested',f.cashBalance===60000,`got ${f.cashBalance}`);
  ok('investments are not expenses',f.totalExp===30000,`got ${f.totalExp}`);
}

/* ── instrValueFromTxs: market vs modelled ── */
{
  const sip={id:'i',type:'SIP',returnRate:12,units:0,currentNAV:43};
  const txs=[{amount:5000,date:'2026-04-10',units:205.599}];
  const v=E.instrValueFromTxs(sip,txs);
  ok('priced at units x latest NAV',near(v.value,205.599*43,1),`got ${v.value}`);
  ok('marked priced',v.priced===true);

  const noUnits=E.instrValueFromTxs({id:'i',type:'SIP',returnRate:12,currentNAV:43},[{amount:5000,date:'2026-04-10',units:0}]);
  ok('falls back to modelled when no units',noUnits.priced===false);

  const unfunded=E.instrValueFromTxs({id:'i',type:'SIP',returnRate:12,units:100,currentNAV:50},[]);
  ok('unfunded instrument is worth nothing',unfunded.value===0,`got ${unfunded.value}`);
}

/* ── xirr ── */
{
  const r=E.xirr([{amount:-1000,date:'2026-01-01'},{amount:1100,date:'2027-01-01'}]);
  ok('xirr ~10% over one year',near(r,10,0.5),`got ${r}`);
  ok('xirr null without sign change',E.xirr([{amount:-100,date:'2026-01-01'},{amount:-100,date:'2026-06-01'}])===null);
  ok('xirr null with too few flows',E.xirr([{amount:-100,date:'2026-01-01'}])===null);
}

/* ── card bill payment: moves cash, never an expense ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:70000,opening:100000}];
  d.transactions=[
    {type:'expense',amount:30000,month:'2026-04',date:'2026-04-02',paymentMode:'Credit Card',category:'Shopping'},
    {type:'cardpay',amount:30000,month:'2026-04',date:'2026-04-20',paymentMode:'NEFT/Bank Transfer',cardId:'c1'},
  ];
  const f=E.computeFin(d,MONTHS);
  ok('card payment is not an expense',f.totalExp===30000,`got ${f.totalExp}`);
}

/* ── paying a card bill must not make you richer ──
   The payable falls, but so does the bank balance, so net worth is unmoved. */
{
  const before=base();
  before.accounts=[{id:'a',type:'bank',balance:100000}];
  before.creditCards=[{limit:200000,payable:30000,provision:0}];
  const after=base();
  after.accounts=[{id:'a',type:'bank',balance:70000}];
  after.creditCards=[{limit:200000,payable:0,provision:0}];
  after.transactions=[{type:'cardpay',amount:30000,month:'2026-04',date:'2026-04-20',
    paymentMode:'NEFT/Bank Transfer',accountId:'a',cardId:'c1'}];
  ok('net worth unchanged by a card payment',
     E.computeFin(after,MONTHS).netWorth===E.computeFin(before,MONTHS).netWorth,
     `${E.computeFin(before,MONTHS).netWorth} -> ${E.computeFin(after,MONTHS).netWorth}`);
}

/* ── loan EMI: full cash out, only interest is a cost ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:86266,opening:100000}];
  d.loans=[{outstanding:100000,emi:13734,roi:12}];
  d.transactions=[{type:'emi',amount:13734,principal:8820,interest:4914,
    month:'2026-04',date:'2026-04-05',paymentMode:'NEFT/Bank Transfer',loanId:'l1'}];
  const f=E.computeFin(d,MONTHS);
  ok('only interest is an expense',f.totalExp===4914,`got ${f.totalExp}`);
  ok('principal repaid is tracked',f.emiPrincipalPaid===8820,`got ${f.emiPrincipalPaid}`);
  ok('full instalment counted as cash out',f.emiCashOut===13734,`got ${f.emiCashOut}`);
  ok('interest lands in a category',f.catMap['Loan Interest']===4914);
}

/* ── paying an EMI must not make you richer ──
   This is the bug the user hit. Marking an instalment paid dropped the loan's
   outstanding by the principal while nothing paid for it, so every payment
   lifted net worth. Paying an EMI should cost you exactly the interest: the
   principal just moves from cash to equity in the asset you borrowed against. */
{
  const before=base();
  before.accounts=[{id:'a',type:'bank',balance:100000}];
  before.loans=[{outstanding:100000,emi:13734,roi:12}];
  const after=base();
  after.accounts=[{id:'a',type:'bank',balance:100000-13734}];
  after.loans=[{outstanding:100000-8820,emi:13734,roi:12}];
  after.transactions=[{type:'emi',amount:13734,principal:8820,interest:4914,
    month:'2026-04',date:'2026-04-05',paymentMode:'NEFT/Bank Transfer',accountId:'a',loanId:'l1'}];
  const nb=E.computeFin(before,MONTHS).netWorth,na=E.computeFin(after,MONTHS).netWorth;
  ok('an EMI costs exactly its interest',nb-na===4914,`${nb} -> ${na}, cost ${nb-na}`);
  ok('net worth falls, never rises',na<nb,`${nb} -> ${na}`);
}

/* ── goal saved amount is derived, so a delete cannot leave it overstated ── */
{
  const goal={id:'g',instruments:[{id:'i1'},{id:'i2'}]};
  const txs=[{goalId:'g',instrumentId:'i1',amount:5000},{goalId:'g',instrumentId:'i2',amount:3000}];
  ok('saved = sum of contributions',E.goalSaved(goal,txs)===8000,`got ${E.goalSaved(goal,txs)}`);
  ok('removing a contribution lowers it',E.goalSaved(goal,txs.slice(0,1))===5000);
  ok('no contributions means zero saved',E.goalSaved(goal,[])===0);
}

/* ── negative carry: money that earns less than your debt costs ── */
{
  const d=base();
  d.accounts=[{id:'fd',name:'FD',type:'fd',balance:500000,rate:7},
              {id:'sb',name:'Savings',type:'bank',balance:100000,rate:3}];
  d.loans=[{id:'l',bank:'X',type:'Personal',outstanding:400000,roi:12,emi:1,tenure:1}];
  const c=E.computeCarry(d);
  // Cheapest money goes first: 1,00,000 at 3% then 3,00,000 at 7%, both against 12%.
  ok('prices the whole overlap',c.deployed===400000,`got ${c.deployed}`);
  ok('gain = sum of spreads',c.annualGain===Math.round(100000*0.09+300000*0.05),`got ${c.annualGain}`);
  ok('cheapest money is redeployed first',c.pairs[0].from==='Savings',`got ${c.pairs[0].from}`);
  ok('leftover is reported idle',c.idle===200000,`got ${c.idle}`);

  const none=E.computeCarry({accounts:[{id:'a',name:'FD',type:'fd',balance:500000,rate:14}],
    loans:[{id:'l',bank:'X',type:'P',outstanding:400000,roi:12}],creditCards:[]});
  ok('no gain when the asset out-earns the debt',none.annualGain===0,`got ${none.annualGain}`);

  const od=E.computeCarry({accounts:[{id:'o',name:'OD',type:'bank',balance:-12000}],loans:[],creditCards:[]});
  ok('a negative balance is listed as debt, not priced as an asset',
     od.overdrafts.length===1&&od.assets.length===0);
}

/* ── survival timeline: what runs out, in what order, on what date ── */
{
  const d=base();
  d.accounts=[{id:'c',name:'Cash',type:'cash',balance:10000},
              {id:'b',name:'Bank',type:'bank',balance:50000},
              {id:'f',name:'FD',type:'fd',balance:100000}];
  const fin={avgMonthlyInc:0,avgMonthlyExp:20000,totalEmi:0};
  const s=E.survivalTimeline(d,fin,{monthlyIncome:0});
  ok('burn is expense plus EMI',s.burn===20000,`got ${s.burn}`);
  ok('total runway = everything / burn',s.monthsLeft===8,`got ${s.monthsLeft}`);
  ok('spends cash before deposits',s.events[0].name==='Cash'&&s.events[2].name==='FD');
  ok('flags insolvency',s.solvent===false);

  const ok2=E.survivalTimeline(d,{avgMonthlyInc:50000,avgMonthlyExp:20000,totalEmi:0},{});
  ok('a surplus means no timeline',ok2.solvent===true&&ok2.monthsLeft===Infinity);
}

/* ── goal reality: required run rate, not a flattering bar ── */
{
  const g={id:'g',name:'R',targetAmount:1000000,targetDate:'2036-04-01',
    instruments:[{id:'i',returnRate:12}]};
  const txs=[{goalId:'g',instrumentId:'i',amount:5000,date:'2026-04-10',month:'2026-04'},
             {goalId:'g',instrumentId:'i',amount:5000,date:'2026-05-10',month:'2026-05'}];
  const r=E.goalReality(g,txs,new Date('2026-04-01'));
  ok('run rate from real contributions',r.actualMonthly===5000,`got ${r.actualMonthly}`);
  ok('required monthly is computed',r.requiredMonthly>0&&r.requiredMonthly<10000,`got ${r.requiredMonthly}`);
  ok('shortfall is signed',r.shortfall===r.requiredMonthly-r.actualMonthly);

  // The flattery this exists to prevent: one lump sum read as a monthly habit.
  const one=E.goalReality(g,[{goalId:'g',instrumentId:'i',amount:20000,date:'2026-04-10',month:'2026-04'}],
    new Date('2026-04-01'));
  ok('one month of history is not a run rate',one.enoughHistory===false&&one.actualMonthly===0);
  ok('and never counts as on track',one.onTrack===false);
}

/* ── recurring radar ── */
{
  const mk=(m,amt,who)=>({type:'expense',merchant:who,amount:amt,month:m,date:m+'-05',category:'Bills'});
  const txs=[mk('2026-04',799,'Fiber'),mk('2026-05',799,'Fiber'),mk('2026-06',799,'Fiber'),
             mk('2026-04',1500,'Power'),mk('2026-05',2800,'Power'),mk('2026-06',2100,'Power'),
             mk('2026-04',300,'NA'),mk('2026-05',300,'NA'),mk('2026-06',300,'NA')];
  const r=E.detectRecurring(txs);
  const fiber=r.found.find(f=>f.merchant==='Fiber');
  ok('a steady monthly charge is a subscription',fiber.kind==='subscription',`got ${fiber.kind}`);
  ok('priced per year',fiber.annual===799*12,`got ${fiber.annual}`);
  ok('a monthly bill that varies is not a subscription',
     r.found.find(f=>f.merchant==='Power').kind==='variable');
  ok('unlabelled merchants are ignored',!r.found.some(f=>f.merchant==='NA'));
  ok('committed total covers both kinds',r.annualCommitted===799*12+Math.round((1500+2800+2100)/3*12),
     `got ${r.annualCommitted}`);
}

/* ── integrity: a stored total that drifts from its entries ── */
{
  const d=base();
  d.goals=[{id:'g',name:'G',currentAmount:50000,instruments:[{id:'i'}]}];
  d.investmentTxs=[{goalId:'g',instrumentId:'i',amount:20000}];
  const r=E.integrityCheck(d);
  ok('catches a drifted goal total',r.issues.some(i=>i.kind==='goal'&&i.diff===30000));
  ok('not clean',r.clean===false);
  ok('scores below full',r.score<100);

  const good=base();
  good.goals=[{id:'g',name:'G',currentAmount:20000,instruments:[{id:'i'}]}];
  good.investmentTxs=[{goalId:'g',instrumentId:'i',amount:20000}];
  ok('clean books score 100',E.integrityCheck(good).score===100);
}

/* ── scenarios: the same engine, run on a hypothetical ── */
{
  const d=base();
  d.accounts=[{id:'a',name:'FD',type:'fd',balance:500000}];
  d.loans=[{id:'l',bank:'X',type:'P',outstanding:400000,emi:10000,roi:12,tenure:60}];
  const alt=E.applyScenario(d,{prepay:{loanId:'l',accountId:'a',amount:200000}});
  ok('prepay moves both sides',alt.loans[0].outstanding===200000&&alt.accounts[0].balance===300000);
  ok('the original is untouched',d.loans[0].outstanding===400000&&d.accounts[0].balance===500000);
  const diff=E.scenarioDiff(E.computeFin(d,MONTHS),E.computeFin(alt,MONTHS));
  ok('net worth is unchanged by a prepayment',diff.netWorth.delta===0,`got ${diff.netWorth.delta}`);
  ok('debt falls',diff.loanOS.delta===-200000,`got ${diff.loanOS.delta}`);
  ok('interest cost falls',diff.monthlyInterestCost.delta<0,`got ${diff.monthlyInterestCost.delta}`);
}

/* ── integrity must not cry wolf on history it cannot repair ── */
{
  const d=base();
  // Instalments recorded before the ledger existed carry no txId.
  d.loans=[{id:'l',bank:'X',type:'P',outstanding:1,paidEmis:[{n:1},{n:2}]}];
  ok('old payments without a ledger link are not drift',E.integrityCheck(d).clean===true);

  const broken=base();
  broken.loans=[{id:'l',bank:'X',type:'P',outstanding:1,paidEmis:[{n:1,txId:'gone'}]}];
  const r=E.integrityCheck(broken);
  ok('a payment whose entry was deleted is drift',r.issues.some(i=>i.kind==='loan'&&i.diff===1));
  ok('and it is repairable',r.fixable===1,`got ${r.fixable}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
