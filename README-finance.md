# New Home Financial System

The public website remains at `/`. The protected application is at `/staff/`; its API is served at `/api/` through a Cloudflare Pages Function, on the same domain as the site.

## Provisioning

1. Install Node 20+ and authenticate: `npx wrangler login`.
2. Create resources: `npx wrangler d1 create new-home-finance` and `npx wrangler r2 bucket create new-home-receipts`.
3. Copy `.dev.vars.example` to `.dev.vars` for local development and set strong unique secrets. D1 and R2 production bindings are configured in the Cloudflare Pages dashboard, never with resource IDs committed to Git.
4. Apply schema through the D1 dashboard SQL console (run `migrations/0001_initial.sql` once), or through Wrangler after binding your own D1 database locally.
5. In Cloudflare Pages, connect the GitHub repository; set **Build command** to `npm install` and output directory to `.`. Pages automatically deploys the static site and the `functions/api/[[path]].js` API adapter. Add the D1/R2 bindings and secrets to the Pages project under **Settings → Bindings / Variables and Secrets**.

The first login bootstraps the admin from the two `BOOTSTRAP_ADMIN_*` secrets, then remove those two secrets. Do not commit `.dev.vars`, real IDs, or secrets.

## إعداد أول حساب أدمن (بالعربي)

لا تكتب أي كلمة مرور في ملف `index.html` أو في GitHub. بعد إنشاء الـWorker، من Cloudflare افتح **Workers & Pages → new-home-finance → Settings → Variables and Secrets** وأضف هذه القيم كـ**Secret**:

| الاسم | القيمة التي تدخلها أنت |
| --- | --- |
| `SESSION_SECRET` | نص عشوائي طويل لا يقل عن 32 حرفًا |
| `BOOTSTRAP_ADMIN_USERNAME` | اسم دخولك، مثل `owner` |
| `BOOTSTRAP_ADMIN_PASSWORD` | كلمة مرور قوية خاصة بك (12 حرفًا على الأقل) |

بعد نشر الـWorker وفتح `/staff/` لأول مرة، سجل الدخول بالاسم وكلمة المرور اللذين اخترتهما. ينشئ النظام حساب الأدمن مرة واحدة فقط. بعدها احذف سري `BOOTSTRAP_ADMIN_USERNAME` و`BOOTSTRAP_ADMIN_PASSWORD` من Cloudflare، واترك `SESSION_SECRET` فقط. إضافة المهندسين لاحقًا تتم من حساب الأدمن؛ لا تشارك كلمة مرورك معهم.

لا ترسل لي كلمة المرور أو `SESSION_SECRET` في المحادثة.

## Recovery

Use scheduled D1 exports/backups and R2 object versioning/retention. Financial records are never deleted: voids, rejections, and cancellations preserve the original record and audit history.
