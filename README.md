# SMART TRADE HUB · חדשות חמות

אוסף כל ~15 דקות (בשעות המסחר) את 2 החדשות החמות בשוק האמריקאי ו-2 בשוק הישראלי, ושומר אותן ב-`data/hot-news.json`.
כרטיס "חדשות חמות" בעמוד הבית של ה-HUB קורא את הקובץ הזה בלבד.

- **הגדרות:** `config.json` (ספים, מסננים, מילות מפתח, מקורות, חלונות זמן, הפעלה/כיבוי לכל שוק). שינוי נכנס לתוקף בריצה הבאה.
- **תזמון:** `.github/workflows/collect.yml`. הרצה ידנית: Actions → Collect hot news → Run workflow (עם `force` כדי להתעלם מחלונות הזמן).
- **הרצה מקומית:** `npm run collect:now` (או `node src/collect.mjs --force --dry` להדפסה בלי כתיבה). בדיקות: `npm test`.
- **SEC:** אפשר להגדיר משתנה `SEC_USER_AGENT` (Settings → Variables) בפורמט `Name contact@domain`. בלי URL.

מקורות: סורק וכותרות TradingView, Reuters ו-Dow Jones, כלכליסט, TheMarker (RSS), SEC 8-K. המערכת רק מביאה חדשות; אין כאן המלצות.
