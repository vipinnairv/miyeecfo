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

/* ── reconciliation: balanced bucket ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:70000,opening:100000},{id:'c',type:'cash',balance:5000,opening:5000}];
  d.transactions=[{type:'expense',amount:30000,month:'2026-04',date:'2026-04-05',paymentMode:'NEFT/Bank Transfer'}];
  const r=E.computeReconciliation(d,MONTHS);
  const bank=r.rows.find(x=>x.key==='bank');
  ok('bank reconciles exactly',near(bank.diff,0),`diff ${bank.diff}`);
  ok('balanced verdict',r.balanced===true);
}

/* ── reconciliation: credit card spend excluded ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:100000,opening:100000}];
  d.transactions=[{type:'expense',amount:5000,month:'2026-04',date:'2026-04-05',paymentMode:'Credit Card'}];
  const r=E.computeReconciliation(d,MONTHS);
  ok('card spend does not move funds',near(r.rows.find(x=>x.key==='bank').diff,0));
  ok('card spend reported separately',r.ccSpend===5000,`got ${r.ccSpend}`);
}

/* ── reconciliation: self-transfer nets to zero ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:97000,opening:100000},{id:'c',type:'cash',balance:8000,opening:5000}];
  d.transactions=[{type:'transfer',amount:3000,month:'2026-04',date:'2026-04-05',paymentMode:'NEFT/Bank Transfer',transferTo:'Cash'}];
  const r=E.computeReconciliation(d,MONTHS);
  ok('transfer debits source',near(r.rows.find(x=>x.key==='bank').diff,0));
  ok('transfer credits destination',near(r.rows.find(x=>x.key==='cash').diff,0));
}

/* ── reconciliation: unclassified payment mode is surfaced ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:100000,opening:100000}];
  d.transactions=[{type:'expense',amount:1200,month:'2026-04',date:'2026-04-05',paymentMode:''}];
  const r=E.computeReconciliation(d,MONTHS);
  ok('missing payment mode is flagged',r.unclassified.length===1);
}

/* ── reconciliation: one unset opening must not hide the bucket's gap ── */
{
  const d=base();
  // Big account with an opening, tiny account without. Real spend leaves a gap.
  d.accounts=[{id:'a',type:'bank',balance:400000,opening:450000},{id:'tiny',type:'bank',balance:100}];
  d.transactions=[{type:'expense',amount:10000,month:'2026-04',date:'2026-04-05',paymentMode:'NEFT/Bank Transfer'}];
  const r=E.computeReconciliation(d,MONTHS);
  const bank=r.rows.find(x=>x.key==='bank');
  ok('bucket still reconciles with a partially set opening',bank.openingSet===true);
  ok('bucket is flagged as not fully covered',bank.fullyCovered===false);
  ok('the unset account is named',bank.accountsWithout.length===1&&bank.accountsWithout[0].id==='tiny');
  // expected = 450000 - 10000 = 440000, actual = 400100 -> gap -39900
  ok('the real gap is reported, not hidden',near(bank.diff,-39900),`diff ${bank.diff}`);
  ok('totals count the assumed-zero accounts',r.totals.assumedZero===1,`got ${r.totals.assumedZero}`);
  ok('allChecked false while an opening is missing',r.totals.allChecked===false);
}

/* ── reconciliation: fully covered bucket reports allChecked ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:90000,opening:100000}];
  d.transactions=[{type:'expense',amount:10000,month:'2026-04',date:'2026-04-05',paymentMode:'UPI'}];
  const r=E.computeReconciliation(d,MONTHS);
  ok('fully covered bucket is allChecked',r.totals.allChecked===true);
  ok('no assumed-zero accounts',r.totals.assumedZero===0);
}

/* ── card bill payment: moves cash, never an expense ── */
{
  const d=base();
  d.accounts=[{id:'a',type:'bank',balance:70000,opening:100000}];
  d.transactions=[
    {type:'expense',amount:30000,month:'2026-04',date:'2026-04-02',paymentMode:'Credit Card',category:'Shopping'},
    {type:'cardpay',amount:30000,month:'2026-04',date:'2026-04-20',paymentMode:'NEFT/Bank Transfer',cardId:'c1'},
  ];
  const r=E.computeReconciliation(d,MONTHS);
  ok('card payment reconciles the bank',near(r.rows.find(x=>x.key==='bank').diff,0),
     `diff ${r.rows.find(x=>x.key==='bank').diff}`);
  ok('card payment is tracked',r.ccPaid===30000,`got ${r.ccPaid}`);
  const f=E.computeFin(d,MONTHS);
  ok('card payment is not an expense',f.totalExp===30000,`got ${f.totalExp}`);
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
  const r=E.computeReconciliation(d,MONTHS);
  ok('full EMI leaves the bank',near(r.rows.find(x=>x.key==='bank').diff,0),
     `diff ${r.rows.find(x=>x.key==='bank').diff}`);
  ok('emi cash tracked in reconciliation',r.emiPaid===13734);
}

/* ── goal saved amount is derived, so a delete cannot leave it overstated ── */
{
  const goal={id:'g',instruments:[{id:'i1'},{id:'i2'}]};
  const txs=[{goalId:'g',instrumentId:'i1',amount:5000},{goalId:'g',instrumentId:'i2',amount:3000}];
  ok('saved = sum of contributions',E.goalSaved(goal,txs)===8000,`got ${E.goalSaved(goal,txs)}`);
  ok('removing a contribution lowers it',E.goalSaved(goal,txs.slice(0,1))===5000);
  ok('no contributions means zero saved',E.goalSaved(goal,[])===0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
