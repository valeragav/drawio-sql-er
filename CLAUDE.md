# CLAUDE.md

Заметки для работы над проектом. Пользовательская документация — README.md.

## Что это

Плагин draw.io: SQL DDL (PostgreSQL, MySQL, SQLite) или живая база PostgreSQL →
ER-диаграмма (таблица — swimlane со строками-колонками, связи между строками, «воронья
лапка»). Плюс обновление диаграммы из новой схемы, сравнение, экспорт в SQL/Mermaid.

Три способа запуска (см. README): Docker (`scripts/server.js`), draw.io Desktop через
`npm start` (`scripts/start-drawio.js`, внедрение по CDP), консоль на app.diagrams.net.

## Команды

```sh
npm run build   # src/*.js → dist/sql-er-plugin.js (свой сборщик, без зависимостей)
npm test        # node --test, все тесты в test/
npm run check   # все модули в сборке + dist актуален + тесты — перед коммитом
npm start       # draw.io Desktop с плагином и мостом к базе (порт CDP 9339)
npm run serve   # сервер как в Docker, без Docker (нужен DRAWIO_DIR в .env)
docker compose up -d --build   # образ: draw.io 31.4.6 из jgraph/drawio + Node-сервер
```

## Устройство

```
src/parser.js    SQL DDL → модель { tables, relations, enums, enumLinks, viewDeps, warnings }
src/drawio.js    модель → XML mxGraphModel: строки, размеры (sizeRows), стили, связи
src/layout.js    раскладка (Sugiyama): циклы → столбцы → «окна» → порядок → Y → сетка
src/routing.js   ортогональная трассировка: дорожки в каналах, коридоры, окна (via)
src/placement.js места для новых таблиц при «Обновить на странице»
src/page.js      операции над страницей в draw.io: reroute, updatePage, refreshFrames,
                 pageCells/diagramModel (снимок для экспорта), markDiff
src/export.js    диаграмма → SQL;   src/mermaid.js  модель → Mermaid erDiagram
src/diff.js      сравнение схем (нормализация типов/выражений)
src/sqltext.js   упрощение выражений PostgreSQL (общее для моста и diff)
src/groups.js    группы-рамки (prefix/schema), FRAME_* отступы
src/select.js    выбор таблиц, «+ связанные»
src/highlight.js подсветка связей выбранной таблицы (mxCellHighlight, красный #e53935)
src/legend.js    легенда в окне;  src/plugin.js  меню, окна, вставка, мост/HTTP к базе
bridge/introspect.js  pg_catalog → DDL (read-only, statement_timeout 30 с)
bridge/errors.js      humanError (коды PG → русский текст, подсказка про Docker), safeHost
scripts/build.js      сборка; список modules — порядок важен, новый модуль добавить сюда
scripts/check.js      проверка перед выпуском
scripts/start-drawio.js  запуск Desktop с --remote-debugging-port, внедрение по CDP, мост
scripts/server.js        HTTP: статика draw.io, PostConfig.js + загрузчик, API introspect
```

Поток: `parseSql` → `toGraphModelXml(model, opts)` (schemaGraph → sizeRows → layout →
buildLinks → routeLinks → XML) → `graph.importCells` в plugin.js.

## Соглашения

- Весь текст для пользователя, комментарии и названия тестов — **по-русски**. Коммиты —
  одна строка по-английски, в нижнем регистре, плюс трейлер Co-Authored-By.
- Коммитить в этом проекте пользователь разрешил сам (только здесь). Автор — как в истории:
  `git -c user.name=VaLeraGav -c user.email=deliciiouss@yandex.ru commit …`. Перед коммитом —
  `npm run build` и `npm run check`; `dist/sql-er-plugin.js` коммитится вместе с исходниками.
- В плагине (`src/`) — никаких зависимостей: CommonJS-модули, собираются scripts/build.js в
  IIFE с маленьким require. Единственная зависимость проекта — `pg` (мост и сервер).
- Стиль кода — как в окружающем коде: 2 пробела, одинарные кавычки, комментарии по делу.
- Переводы строк — LF (`.gitattributes`). Сборка нормализует CRLF при чтении исходников.
- Правки файлов — через Edit/Write или node-скрипт в файле из scratchpad. heredoc с
  `\\/`, `\\n`, `$'` в `String.replace` уже ломали файлы: используйте функцию-заменитель
  `s.replace(a, () => b)` и проверяйте результат (`node --check`, grep).

## Пожелания пользователя (не нарушать)

- Таблицы **не раскрашивать**, стандартный стиль draw.io. Подсветка связей — красная.
- CLI-версии не нужно; фоновый мост (служба) пока не нужен.
- Ограничения из базы — «как в базе», включая дубликаты одинаковых CHECK (с предупреждением).
- Пароль к базе — отдельным полем, никогда не сохранять и не писать в журнал.
- Мост и сервер — только чтение базы.
- Проект mvp-ml2 и его базу не менять без подтверждения. Его схема для ручной проверки:
  `C:/Users/user/Projects/my/Data Science/machinelearningforkids/localstart/mvp-ml2/sql/schema.sql`.
- Прежде чем делать крупное — план и согласование; отвечать по-русски.

## Метки в стилях и атрибутах ячеек

По ним плагин узнаёт свои ячейки на странице — не переименовывать:

- `sqlErTable=1` — таблица / VIEW / ENUM; `sqlErName=<encodeURIComponent(ключ)>` — ключ узла
  (подпись пользователь может менять), у ENUM ключ `enum:<имя>`;
- `sqlErLink=1` — наша связь; `sqlErVia=dy1,dy2` — Y «окон» длинной связи от верха
  таблицы-родителя (для «Перепроложить связи»);
- `sqlErGroup=1`, `sqlErGroupBy=prefix|schema`, `sqlErName=group:<имя>` — рамка группы;
- `sqlErHidden=1` + атрибут `sqlErHidden` (JSON) — свёрнутые колонки компактного режима;
- строки — UserObject с атрибутами `tooltip` и др.

## Раскладка (src/layout.js) — важное

- Циклы: жадный Eades–Lin–Smyth (`acyclicOrder`), затем самый длинный путь, родитель
  придвигается к ближайшему ребёнку.
- Длинная связь получает «окна» (фиктивные узлы высоты 0) в промежуточных столбцах; окна
  участвуют в сортировке и занимают место между таблицами (WINDOW_GAP 20, шаг 12).
- Порядок: медиана по Y **строк** соседей, transpose по `pairCrossings`, пересечения между
  столбцами — подсчёт инверсий. Итог выбирается из ≤ MAX_CANDIDATES порядков по
  **настоящей трассировке** (`routeScore`) — это дало основной выигрыш.
- Группа — блок на столбцах lo..hi (skyline), члены группы в столбце непрерывны.
- Таблицы без связей — сеткой под схемой (`placeGrid`); в routing.js они не склеивают столбцы.
- Скорость: 80 таблиц ≈ 0,3 с, 300 ≈ 1 с. Не возвращать O(n²) пересчёты в transpose.
- Метрики сравнения (пересечения, изломы, размеры) удобно считать скриптом по XML; на
  mvp-ml2 с группами было 34 пересечения → стало 24.

## Подводные камни draw.io

- **Свои плагины запрещены** (`ALLOW_CUSTOM_PLUGINS=false`, *Extras → Plugins* — только
  встроенные; `--enable-plugins` в Desktop больше нет). Поэтому Desktop — CDP-внедрение,
  Docker — загрузчик в PostConfig.js, сайт — консоль.
- **CSP Desktop** (`connect-src`) запрещает fetch даже к localhost → мост через
  `Runtime.addBinding('sqlErDbRequest')` и ответ `window.__sqlErDbResponse`; жив ли мост —
  по `window.__sqlErBridgeSeen`; версия сборки — `window.__sqlErBuild` (мост перечитывает
  dist при изменении и подгружает новую сборку поверх старой).
- **PostConfig.js выполняется до App.main**: `Draw.loadPlugin` ещё нет → загрузчик сервера
  вызывает `App.initPluginCallback()` и `App.embedModePluginsCount++`, иначе плагин молча
  не регистрируется.
- **Service worker** draw.io кэширует PostConfig.js → сервер отдаёт вместо service-worker.js
  пустой worker, который себя удаляет.
- Образ jgraph/drawio: файлы в `/usr/local/tomcat/webapps/draw`; `WEB-INF`/`META-INF`
  не копировать и не отдавать.
- Текст HTML-подписей — только через `DOMParser` (`htmlToText` в page.js), не `innerHTML`.
- `mxUtils.setStyle(style, key, null)` удаляет ключ.
- Меню «Вставить» плагина — подменю в *Упорядочить* (`ui.menus.get('insert')`).
- Ширина текста в draw.io — `mxUtils.getSizeForString` (opts.measureText), без браузера —
  оценка `estimateTextWidth`; у строки внутренний отступ текста 2 px с каждой стороны.
- Desktop из Microsoft Store флаги не принимает — нужна версия из winget (`JGraph.Draw`),
  путь `%LOCALAPPDATA%\Programs\draw.io\draw.io.exe`.

## Проверка вживую

- **Desktop**: `npm start`, затем по CDP на `127.0.0.1:9339` (`/json/list` → WebSocket →
  `Runtime.evaluate`) можно выполнять код в окне редактора.
- **Docker / сайт**: headless Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe
  --headless=new --remote-debugging-port=…`), в странице `Draw.loadPlugin(ui => …)` даёт
  `ui`; окно плагина — `ui.actions.get('sqlErImport').funct()`, дальше клики по DOM
  `.geDialog`. Скриншот — `Page.captureScreenshot`.
- **База для проверки**: `docker run -d --name sqler-pg-test -e POSTGRES_PASSWORD=testpw
  -e POSTGRES_DB=shop -p 127.0.0.1:55432:5432 postgres:16-alpine`, залить
  `examples/ecommerce.sql`; из контейнера плагина — `host.docker.internal:55432`.
  После проверки контейнер удалить.
- PNG из .drawio без открытия окна: `draw.io.exe -x -f png -o out.png file.drawio`.
