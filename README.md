📁 Personal FinManager: Professional README
Welcome to Personal FinManager, a comprehensive, secure, and insightful financial workspace designed by Vipin Nair. This tool balances robust accounting with AI-driven strategy to help you master your net worth. 🚀
🌟 Core Features
Net Fund Balance Tracking: Monitor Bank, Cash, FD, and Digital Wallets in one unified view. 🏦

Credit Card Command Center: Track utilization, billed/unbilled amounts, and get urgent alerts for upcoming dues. 💳

Loan & Debt Optimizer: Analyze amortization schedules, interest costs, and prioritize payoffs using Avalanche or Snowball methods. 📉

Budget vs. Actual: Real-time tracking of monthly utilization to prevent overspending. ⚖️

AI Financial Advisor: Integrated with Groq, Gemini, and Claude to provide deep-dive insights into your spending patterns and health score. 🤖

Savings Goals: Dedicated goal-based tracking with "months to completion" and required SIP calculations. 🎯
🔐 Privacy & Security
Client-Side Processing: Your data stays in your browser's local storage. 🔒

Google Drive Sync: Optional cloud backup. Data is saved in a private folder (PersonalFinManager) that only this app can access. ☁️

API Key Safety: AI provider keys are stored locally and never transmitted to external servers except the provider itself. 🛡️
🛠️ Technical StackCategoryToolsFrontendReact 18, Babel (Standalone)StylingModern CSS with CSS Variables & Flex/GridChartsChart.js 4.4StorageBrowser LocalStorage + Google Drive APIUtilitiesSheetJS (Excel Export), Google Identity ServicesAI ModelsLlama 3.3, Gemini 2.0 Flash, Claude 3.5 Sonnet
📈 CFO Dashboard Metrics
Monitor your financial health through institutional-grade ratios:

Savings Rate: Your surplus as a percentage of income.  

Burn Rate: Average daily and monthly outflow calculations.  

Fund Runway: How many months you can survive on liquid assets + FDs.  

Health Score: A weighted 0-100 score based on debt burden, utilization, and liquidity.
🚀 Getting Started
Configure Profile: Set your reporting period (e.g., April to March) in Profile & Period.  

Add Accounts: Input your bank balances and credit limits in the Fund Balance tab.  

Sync: Connect your Google Drive in the Drive Sync tab for multi-device access.  

Analyze: Use the AI Insights tab to identify "leaks" in your budget.
Note: For personalized professional help, use the Book Consultation button in the top bar to connect directly with Vipin Nair via Google Calendar. 📅

## Development

The UI is authored as JSX in `src/app.jsx` (the source of truth). `index.html` ships **precompiled** JavaScript inlined between the `__APP_START__` / `__APP_END__` markers, so browsers load no Babel and do no runtime transpiling, so the app starts in about a second instead of 20–30.

After editing `src/app.jsx`, regenerate `index.html`:

```
npm install   # once, to fetch @babel/standalone
npm run build # transpiles src/app.jsx and injects it into index.html
```

Do not hand-edit the compiled block in `index.html`; it is overwritten on every build.
