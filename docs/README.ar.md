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

أهم متغيرات البيئة هي `PI_HARNESS_HOST` و`PI_HARNESS_PORT` و`PI_AGENT_DIR`. العنوان الافتراضي هو `http://127.0.0.1:3141`.

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

للاطلاع على كتالوج الإضافات الكامل والإعدادات وواجهة API والحدود الأمنية، راجع [المرجع الكامل بالإنجليزية](README.reference.md).

## الترخيص

MIT. راجع [LICENSE](LICENSE).
