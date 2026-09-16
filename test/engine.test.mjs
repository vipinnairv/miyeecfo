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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
