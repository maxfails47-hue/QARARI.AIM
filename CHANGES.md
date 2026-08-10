# ملخص التعديلات — Qarari AI

## 1. تعديل GuideScreen (دليل الاستخدام)
- **ملف:** `src/components/GuideScreen.tsx`
- تم تغيير "50 تحليل شهري (بدل 10 في المجاني)" إلى **"50 تحليل شهري (بدل 5 في المجاني)"**
- تم **حذف** جملة "300 رسالة شات شهرية للمساعد (بدل 300 للمجاني)" بالكامل

## 2. تعديل سعر الاشتراك إلى 150 EGP
| الملف | التعديل |
|--------|---------|
| `src/components/UpgradeScreen.tsx` | 149 EGP → **150 EGP** |
| `src/lib/types.ts` | `MONTHLY_PRICE = 149` → **150** |
| `api/subscribe.ts` | `MONTHLY_PRICE = 149` → **150** |
| `api/admin/metrics.ts` | `MONTHLY_PRICE = 149` → **150** |

## 3. ربط الذاكرة الذكية بتسجيل الدخول
- **ملف:** `src/components/AdvisorScreen.tsx` (جديد)
- عند فتح المساعد الشخصي بدون تسجيل دخول، يظهر:
  - **رسالة:** "عشان أقدر أفتكر اهتماماتك وأقدملك نصائح مخصصة ليك، ياريت تسجل دخولك"
  - زر "سجّل دخولك" يوجه لصفحة تسجيل الدخول فوراً
- **ملف:** `api/ask.ts` — الـ API يرجع 401 `auth_required_for_advisor` إذا لم يسجل المستخدم
- **ملف:** `src/components/InputScreen.tsx` — زر المساعد على الصفحة الرئيسية يتحقق من تسجيل الدخول

## 4. Proactive Suggestions (نصائح استباقية)
- **ملف:** `src/components/AdvisorScreen.tsx`
- بعد كل رد من المساعد، تظهر نصيحة استباقية ذكية بناءً على السياق
- أمثلة:
  - "الموديل اللي بتسأل عليه ده نزل منه نسخة أحدث، تحب أقارنلك؟"
  - "في عرض جديد على iPhone 14 دلوقت!"
  - "لافتوبات للدراسة، الـ Acer و Lenovo معمولين عليهم عروض كويسة!"
- **ملف:** `api/ask.ts` — تحديث prompt المساعد ليطلب نصائح استباقية

## 5. Smart Memory System (ذاكرة ذكية)
- **ملف:** `api/ask.ts` — بعد كل سؤال في وضع advisor:
  - يستخرج كلمات مفتاحية (موبايل، لابتوب، سماعات، إلخ)
  - يحفظ الاهتمامات في جدول `user_interests`
  - يحفظ آخر 20 بحث في `recent_searches`
  - دمج تلقائي مع الاهتمامات السابقة
- **ملف:** `supabase-user-interests-migration.sql` (جديد) — إنشاء جدول `user_interests` و `advisor_usage`
- **ملف:** `src/components/AdvisorScreen.tsx` — عرض مؤشر "الذاكرة الذكية نشطة"

## 6. Shopping Advisor Mode (وضع المساعد الشخصي)
- **ملف:** `src/components/AdvisorScreen.tsx` (جديد) — شاشة كاملة للمساعد الشخصي
- **ملف:** `src/components/InputScreen.tsx` — إضافة قسم "المساعد الشخصي الذكي" على الصفحة الرئيسية
- **ملف:** `src/components/Header.tsx` — إضافة أيقونة المساعد في الـ header
- **ملف:** `src/App.tsx` — إضافة route للشاشة الجديدة
- **ملف:** `src/lib/types.ts` — إضافة "advisor" للـ Screen type
- العميل يقدر يسأل: "معايا 30 ألف وعايز لابتوب للدراسة" أو "إيه أحسن موبايل كاميرا في 25 ألف؟"
- المساعد يرد بنصائح شخصية وأسعار حقيقية

## تحديث خطط الاشتراك ومقارنة أسعار المتاجر (هذا التحديث)

### 1. تحديث أرقام خطط الاشتراك — `api/_planConfig.ts`
| الخطة | السعر | تحاليل | مقارنات | رسائل شات |
|-------|-------|--------|---------|-----------|
| small_bundle | 49 | 4 | 0 | 45 |
| medium_bundle | 79 | 7 | 0 | 90 |
| large_bundle | 119 | 11 | 0 | 150 |
| smart_shopper | 150 | 16 | 3 | 150 |
| power_buyer | 300 | 30 | 8 | 400 |

تم تحديث حقل `description` لكل باقة ليعكس الأرقام الجديدة.

### 2. مقارنة أسعار المتاجر داخل ReportScreen
- **`api/_groq_tavily.ts`**: دالة جديدة `extractRetailerPrices()` تستخرج أرخص سعر ورابط مباشر من نتايج "Search 2: Largest Marketplace" الموجودة أصلاً (بدون أي Serper إضافي) لكل من Jumia وNoon (وB.TECH لو `SHOW_BTECH_COMPARISON=true`)، مع استبعاد amazon.eg تمامًا. `smartAdaptiveSearch` بترجع دلوقتي `retailerSearchResults` كجزء من الـ return، و`callAiWithFallback` بيمررها للخارج.
- **`api/analyze.ts`**: بينادي `extractRetailerPrices` بعد نتيجة الـ AI ويخزنها في `parsed.retailerPrices` (فبتترخزن مع الكاش كمان).
- **`src/lib/types.ts`**: حقل جديد `retailerPrices?` في `AnalysisResult`، وثابت `SHOW_BTECH_COMPARISON` (حاليًا `false`).
- **`src/components/ReportScreen.tsx`**: كومبوننت جديد `RetailerPriceComparison` يظهر تحت "Market Overview" لو فيه أكتر من متجر، بنفس ثيم الموقع (خلفية داكنة، amber/gold، RTL)، مع badge أخضر لأرخص سعر، وتنبيه واضح إن الأسعار "آخر سعر اتفحص" وممكن تتغير.
- **`SETUP.md`**: توثيق env var اختياري جديد `SHOW_BTECH_COMPARISON`.

## دفعة تعديلات جديدة (تجميع Serverless Functions + إصلاحات + ميزات)

### 1. تقليل عدد Serverless Functions من 12 إلى 5 (حل مشكلة Build Failed على Vercel Hobby)
- تم دمج 6 مسارات إدارية في ملف واحد `api/admin.ts` (يفرّع حسب `?action=requests|approve|reject|metrics|ai-costs|login`)
  - الملفات المحذوفة: `api/admin/requests.ts`, `api/admin/approve.ts`, `api/admin/reject.ts`, `api/admin/metrics.ts`, `api/admin/ai-costs.ts`, `api/admin/login.ts`
- تم دمج 3 مسارات مستخدم في ملف واحد `api/user.ts` (يفرّع حسب `?action=scans-remaining|compare|subscribe|classify-icon`)
  - الملفات المحذوفة: `api/scans-remaining.ts`, `api/compare.ts`, `api/subscribe.ts`
- الدوال المتبقية الآن: `api/analyze.ts`, `api/ask.ts`, `api/admin.ts`, `api/user.ts`, `api/cron/daily.ts` = **5 دوال فقط**
- تم تحديث كل استدعاءات الـ fetch في الواجهة الأمامية (`InputScreen.tsx`, `ProfileScreen.tsx`, `CompareScreen.tsx`, `UpgradeScreen.tsx`, `AdminApp.tsx`) للمسارات الجديدة
- **باج إضافي تم اكتشافه وإصلاحه:** متغير `COMPARE_MONTHLY_LIMIT` كان غير معرّف إطلاقاً في `api/compare.ts` القديم — كان سيسبب خطأ في كل عملية مقارنة ناجحة. تم تصحيحه لاستخدام `comparesLimit` الصحيح داخل `api/user.ts`.

### 2. أيقونات ذكية بالذكاء الاصطناعي (Groq)
- إضافة `classifyProductCategory()` في `api/_groq_tavily.ts` — استدعاء سريع وخفيف لنموذج Groq الأصغر (20b) لتصنيف اسم المنتج
- إضافة action جديد `classify-icon` في `api/user.ts`
- `src/lib/categoryIcons.ts`: إضافة `getIconByCategory()` لربط تصنيف Groq بأيقونة Lucide
- `InputScreen.tsx`: الأيقونة المحلية الفورية تظهر أولاً دون أي تأخير، ثم تُستبدل (تُرقّى) بأيقونة أدق إذا رجع تصنيف Groq (مع debounce 500ms وقطع تلقائي بعد 4 ثواني كحد أقصى)

### 3. سكريبت التفاوض — التعامل الصحيح مع الصفقة الممتازة
- تعزيز تعليمات البرومبت في `api/analyze.ts` (negotiationScript) بدون أي تعديل على منطق حساب السعر العادل: عند كون العرض أقل من الحد الأدنى، يمتدح السكريبت الصفقة صراحة ولا يطلب خصم إضافي، ويطلب فقط التأكد من عدم كون الجهاز مسروقاً وعدم وجود عيب خفي

### 4. مؤشر تحميل احترافي لزر "حلل القرار"
- `InputScreen.tsx`: رسائل تفاعلية متغيرة كل 3.5 ثانية أثناء التحليل + Skeleton bars متحركة + الزر معطل تلقائياً أثناء التحميل (كان موجوداً ويظل معطلاً)

### 5. إصلاح زر إرسال "اسأل المساعد الذكي"
- الباج: `onClick={sendChat}` كان يمرر الـ click event نفسه كأول معامل (يستبدل نص السؤال)، ما يسبب خطأ صامت ويمنع أي استجابة
- تم إصلاحه في 3 مواضع: `ReportScreen.tsx` و`InputScreen.tsx` (زر واحد لكل ملف)

### 6. إصلاح صفحة "متابعاتي" (اختفاء البيانات + عودة المنتج بعد الحذف)
- `WatchlistScreen.tsx`: تم التحقق من تسجيل الدخول عبر `session` (فوري) بدلاً من `user` (بروفايل يتأخر تحميله)، مع انتظار `authLoading` — يمنع التوجيه الخاطئ لصفحة الدخول والشاشة الفارغة المؤقتة
- الحذف أصبح نهائياً (`DELETE`) بدلاً من soft-delete، مع التحقق الفعلي من نجاح الحذف عبر `.select()` بدل الثقة العمياء بغياب `error`
- ملف SQL جديد: `supabase-watchlist-delete-policy-migration.sql` (سياسة RLS تسمح بالحذف الفعلي — **يجب تشغيله على قاعدة البيانات في Supabase**)

### 7. ميزة PWA كاملة
- ملفات جديدة: `public/manifest.json`, `public/favicon.svg`, `public/sw.js`, `public/icons/*.png`
- `index.html`: ربط manifest + meta tags (theme-color, apple-touch-icon، إلخ)
- `src/main.tsx`: تسجيل الـ Service Worker (يستثني كل `/api/*` من التخزين المؤقت حفاظاً على تحديث البيانات الحية)

### ⚠️ لم يتم لمس أي كود يخص حساب "السعر العادل" (Fair Price Logic) إطلاقاً — بناءً على طلب صريح.

### مطلوب منك بعد الرفع:
1. شغّل ملف `supabase-watchlist-delete-policy-migration.sql` في Supabase SQL editor.
2. تأكد إن متغيرات البيئة (`GROQ_API_KEY` إلخ) موجودة في Vercel — نفس الموجودة قبل كده، مفيش جديد.

---

## مراجعة ما قبل الإطلاق (Pre-Launch Review) — الجلسة الحالية

### 1. 🔴 ثغرة أمنية حرجة: جداول بدون RLS خالص
عدد من الجداول اتعملت في migrations سابقة بتعليق "No RLS needed — backend only"، وده افتراض غلط: أي مشروع Supabase بيبعت الـ `anon key` العام جوه كود المتصفح، وطالما RLS مقفول، أي حد يقدر يكلم REST API بتاع Supabase مباشرة (من غير ما يعدي على التطبيق خالص) ويقرا/يعدّل الجدول ده. الجداول المتأثرة:
`analysis_cache`, `chat_usage`, `product_price_events`, `device_usage_logs`, `guest_device_aliases`, `admin_audit_log`, `guest_usage`, `ai_usage_log`, `cron_logs`, `advisor_usage`, `noon_affiliate_links`

أخطر تأثير: أي حد كان يقدر يصفّر الـ quota بتاعه في `device_usage_logs`/`guest_usage` مباشرة، وده بالظبط اللي نظام الـ device fingerprint اتعمل عشان يمنعه.

**الحل:** ملف جديد `supabase-lockdown-backend-only-tables-migration.sql` — بيفعّل RLS من غير أي policies (يعني منع تام لأي حد غير الـ service role key). **لازم يتشغل قبل الإطلاق.**

### 2. متغير بيئة ناقص من التوثيق: `SERPER_API_KEY`
كان مستخدم فعليًا في `api/_groq_tavily.ts` كـ fallback لما Groq Compound يفشل، لكن مكانش موجود في `SETUP.md` — يعني ممكن حد ينساه وقت الرفع على Vercel، والـ fallback هيفشل صامت، وده سبب محتمل لمشكلة "عدم دقة السعر" المذكورة. تم توثيقه دلوقتي في `SETUP.md`.

### مطلوب منك بعد الرفع (إضافة على القايمة اللي فوق):
3. شغّل `supabase-lockdown-backend-only-tables-migration.sql` في Supabase SQL Editor.
4. تأكد إن `SERPER_API_KEY` موجود في Environment Variables على Vercel.
