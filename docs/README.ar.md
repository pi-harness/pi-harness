# Pi Harness

‏Pi Harness هو مضيف ويب يعتمد على الإضافات لـ [Pi](https://github.com/earendil-works/pi)، ومبني على DeepSeek Cordis. يوفّر وحدة تحكم للمتصفح وواجهة HTTP وأداة CLI.

اللغات: [English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [Italiano](README.it.md)

## التثبيت

يتطلب Node.js 22.19 أو أحدث و npm 10 أو أحدث.

```sh
npm install --global @pi-harness/pi-harness
pi-harness
```

يكفي عادةً تثبيت الحزمة الرئيسية؛ إذ تُثبّت تبعيات التنفيذ، ومنها `@pi-harness/core`، تلقائياً.

## التشغيل من المصدر

```sh
npm ci
npm run build
npm run web
```

## التحديث والإعداد

عند التشغيل، يتحقق Pi Harness في الخلفية من وجود إصدار متوافق أحدث من `@pi-harness/core`. لا يؤخر ذلك بدء التشغيل، ويعرض الأمر عند توفر تحديث ويتجاهل أخطاء الشبكة. للتحديث شغّل `npm update --global @pi-harness/pi-harness`، أو عطّل التحقق باستخدام `PI_HARNESS_DISABLE_UPDATE_CHECK=1`.

أهم متغيرات البيئة هي `PI_HARNESS_HOST` و`PI_HARNESS_PORT` و`PI_AGENT_DIR` و`PI_HARNESS_PROVIDER` و`PI_HARNESS_MODEL`. العنوان الافتراضي هو `http://127.0.0.1:3141`.

يختار profile وحدة تحكم الويب ([`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml)) النموذج `everyapi/deepseek-v4-flash` افتراضياً. واختيار النموذج fail-closed: إذا لم يكن ذلك المزوّد مسجّلاً في `PI_AGENT_DIR` النشط، يتوقف التشغيل بالخطأ `Pi model is not registered: <provider>/<model>` بدلاً من التحوّل إلى مزوّد آخر. لذلك جهّز كتالوج النماذج أولاً بعد التثبيت الجديد: شغّل `everyapi use pi-harness` إن كانت أداة EveryAPI CLI مثبّتة، فهي تُهيّئ مجلد Pi agent معزولاً يحتوي كتالوج مزوّدي EveryAPI ثم تُشغّل Pi Harness، أو وجّه `PI_HARNESS_PROVIDER` و`PI_HARNESS_MODEL` إلى نموذج مسجّل مسبقاً في ذلك المجلد. أما profile الافتراضي `default` المضمّن في CLI فيختار `deepseek/deepseek-v4-flash`.

## CLI

```sh
pih --profile default "لخّص المجلد الحالي"
pih --profile development "لخّص المجلد الحالي"
pih --config ./cordis.yml "لخّص المجلد الحالي"
```

الخيارات هي `--profile` و`--config` و`--dump-config` و`--help` و`--version`. Profile هو قائمة من إدخالات Cordis Loader، ويحتاج كل إدخال إلى `id` فريد واسم وحدة في `name`.

## البنية والإضافات

تجمع مكوّنات Loader وInclude وGroup في Cordis إضافات النماذج والموارد والجلسات والأدوات وruntime وWeb/API وstdio. إن `@pi-harness/core` حزمة npm مستقلة تحتوي عدة إضافات Cordis وليست إضافة واحدة. تُثبّت الإضافات الخارجية عبر npm وتُذكر في `cordis.yml`.

## التطوير

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

للاطلاع على كتالوج الإضافات المنتقى والإعدادات وجميع مسارات واجهة HTTP API والحدود الأمنية، راجع [المرجع بالإنجليزية](README.reference.md). ويضم core إضافات أكثر مما يصفه ذلك الكتالوج: المجموعة الكاملة في [`packages/core/src/plugins`](../packages/core/src/plugins)، وما تُفعّله وحدة تحكم الويب افتراضياً مذكور في [`apps/web/profile/cordis.yml`](../apps/web/profile/cordis.yml).

## الترخيص

MIT. راجع [LICENSE](LICENSE).
