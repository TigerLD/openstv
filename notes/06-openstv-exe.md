# 06 — OpenSTV.exe: сборка standalone-файла

## Что это

`exporter/dist/OpenSTV.exe` — Node.js Single Executable Application (SEA).
Внутри: сам Node 24.22.3, бандл `cli.mjs` (esbuild), `exceljs` и весь наш код.
На машине пользователя Node и npm не нужны.

Размер ~92 МБ — это в основном ядро Node (`node.exe` ≈ 94 МБ).

## Как собрано

`exporter/build.mjs`:

1. **esbuild**: `cli.mjs` → `build/openstv.cjs`
   (`bundle: true, platform: node, format: cjs, target: node24`).
   Формат CJS обязателен: SEA грузит только CommonJS.
2. **Blob**: `node --experimental-sea-config build/sea-config.json`
   → `build/openstv.blob` (`disableExperimentalSEAWarning`, `useCodeCache: false`).
3. **Копия**: `node.exe` → `dist/OpenSTV.exe`.
4. **Инъекция**: `postject.inject(exe, "NODE_SEA_BLOB", blob, { sentinelFuse })`
   с фиксированной fuse-строкой
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`.
5. **Подсистема PE**: `OpenSTV.exe` → GUI (2), копия `OpenSTV-cli.exe` → console (3).

Смещение поля Subsystem в PE: `e_lfanew + 0x5C` (u16). Значение 2 — GUI
(консольного окна нет), 3 — консоль. Так один и тот же бандл работает и как
приложение, и как обычная утилита.

Запись 92-МБ файла иногда блокируется антивирусом (`EBUSY`), поэтому
копирование и правка заголовка обёрнуты в `retry()`.

```powershell
cd C:\OpenSTV\exporter
$env:PATH = "C:\node;$env:PATH"
& C:\node\npm.cmd install --no-audit --no-fund
& C:\node\node.exe .\build.mjs
```

Предупреждения при сборке:

- `warning: The signature seems corrupted!` — подпись Microsoft у скопированного
  `node.exe` после инъекции недействительна. Для локального инструмента это нормально.
- npm может ругаться на `install-scripts` для esbuild, но бинарник esbuild
  приходит отдельным пакетом `@esbuild/win32-x64` и работает.

## Особенность argv в SEA

В SEA `process.argv` выглядит так:

```
[ "C:\...\OpenSTV.exe", "C:\...\OpenSTV.exe", "inspect", "C:\Трассы" ]
```

То есть путь к exe дублируется. Поэтому в `cli.mjs`:

```js
function userArgs() {
  if (!isSea()) return process.argv.slice(2);
  const a = [...process.argv];
  while (a.length && resolve(a[0]).toLowerCase() === resolve(process.execPath).toLowerCase()) a.shift();
  return a;
}
```

`isSea()` — из встроенного модуля `node:sea`.

## Проверено

| Проверка | Результат |
|---|---|
| `OpenSTV-cli.exe version` / `--help` | OK |
| `inspect` на образцах | OK, CRC OK |
| `export` на 507 трассах («Пирогово тест гараж») | 507 листов + сводка, 1054 события |
| `csv` | OK |
| `transform` (`--shift-days`, `--fiber-start`, шаблон имён) | OK, CRC OK после правки |
| Запуск из другой папки с кириллическим путём | OK |
| GUI: двойной щелчок, сканирование, таблица, экспорт | OK, ошибок в консоли нет |
| GUI: «Завершить» | процесс завершается |

## Графическая оболочка

`OpenSTV.exe` (subsystem 2) запускает HTTP-сервер на `127.0.0.1` со случайным
портом и открывает браузер через `cmd /c start`. Страница целиком встроена
в бандл (`src/gui.mjs`), внешних файлов нет.

API (только loopback, JSON):

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/api/scan` | список трасс в папке + метаданные |
| POST | `/api/export` | Excel/CSV по выбранным файлам |
| POST | `/api/transform` | пакетное изменение в отдельную папку |
| POST | `/api/browse` | системный диалог выбора папки/файла (PowerShell) |
| POST | `/api/quit` | остановить OpenSTV |
| GET | `/api/ping` | проверка, что экземпляр уже запущен |

Порт работающего экземпляра пишется в `%TEMP%\openstv.port`. Повторный
двойной щелчок проверяет `/api/ping` и просто открывает уже работающий
интерфейс в новой вкладке, не создавая второй процесс.

Диалоги «Обзор…» — `FolderBrowserDialog` / `SaveFileDialog` из
`System.Windows.Forms`, запускаются через `powershell -STA` с `-WindowStyle Hidden`.

## Ограничения

- `transform` пишет только v2 (Bellcore 2.0, есть блок `Map`).
- Версия ресурса exe остаётся от `node.exe` (FileVersion Node 24.22.3);
  при желании правится `rcedit`, но для работы не требуется.
- Антивирус может ругаться на неподписанный exe, собранный из `node.exe`.
