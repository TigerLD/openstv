# 05 — Формат SOR: что реально в файлах

Разобрано на `samples/cross-1_032.sor` и `cross-1_1310_033.sor`
(Bellcore 2.0, прибор S/N 6000113400, ПО 1.00.39).

## Общая структура (v2)

```
Map\0 | u16 version (200) | u32 mapSize | u16 ??? | u16 blockCount
      | entries...
entry = name\0 | u16 version (200) | u32 size
body  = name\0 | data...
```

- `size` — **полный** размер блока, включая имя и завершающий NUL.
- Тела блоков идут подряд сразу после Map; их начало = `mapSize`.
- Порядок в файле: GenParams, SupParams, FxdParams, KeyEvents, DataPts,
  OTDRUsrParams (необязательный), Cksum.
- Cksum — последние 2 байта файла; CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
  по всем байтам от 0 до начала CRC, **включая** `Cksum\0` и версию.

## GenParams (v2)

| Поле | Тип | Пример |
|---|---|---|
| language | 2 байта ASCII | `EN` |
| cable ID | cstr | `SM` |
| fiber ID | cstr | `32` |
| fiber type | u16 | 652 |
| wavelength | u16 | **1310** (см. ниже) |
| location A | cstr | `1km` |
| location B | cstr | `1m` |
| cable code / fiber type | cstr | ` ` |
| build condition | 2 байта | `NC` |
| user offset | i32 | 0 |
| user offset distance | i32 | 0 |
| operator | cstr | `Lupanov D.V.` |
| comment | cstr | |

## FxdParams

| Поле | Тип | Пример |
|---|---|---|
| date/time | u32 (unix) | 1729080358 |
| units | 2 байта | `km` |
| wavelength | u16 | **1310** |
| acquisition offset | i32 | 0 |
| acquisition offset distance | i32 | 0 |
| pulse width entries | u16 | 1 |
| pulse widths | u16 × n | 5 |
| sample spacing | u32 × 1e-8 мкс | 707565 → 0.00707565 мкс |
| number of data points | u32 | 1508 |
| index of refraction | u32 × 1e-5 | 146600 → 1.466 |
| backscatter | u16 × 0.1 дБ (со знаком −) | −79.4 |
| number of averages | u32 | 0 |
| averaging time | u16 × 0.1 с | 10 |
| range | u32 | |
| acquisition range distance | i32 | 20 (км) |
| front panel offset | i32 | 0 |
| noise floor level | u16 | 65535 |
| noise floor scale | i16 | 1000 |
| power offset first point | u16 | 0 |
| loss threshold | u16 × 1e-3 | 1 |
| reflection threshold | u16 × −1e-3 | −1 |
| end-of-trace threshold | u16 × 1e-3 | |
| trace type | 2 байта | `ST` |
| X1..Y2 | i32 × 4 | |

### Единицы длины волны — важное расхождение

SR-4731 v2 требует хранить длину волны в **0.1 нм** (13100 для 1310 нм).
В разобранных файлах записано **1310**, то есть прибор пишет нанометры как есть.
`sor-reader` умножает на 0.1 и выдаёт `131.0 nm`, что неверно для этих файлов.

Правило: если raw ≥ 8000 — это 0.1 нм (делим на 10), иначе — уже нм.

## KeyEvents (v2)

```
u16 count
for each:
  u16 number
  u32 distance (0.1 нс времени пролёта)
  i16 slope × 1e-3 (дБ/км)
  i16 splice loss × 1e-3 (дБ)
  i32 reflection loss × 1e-3 (дБ)
  8 байт event type, например "1FFFFFLS"
  u32 end of previous
  u32 start of current
  u32 end of current
  u32 start of next
  u32 peak
  cstr comment
```

Перевод времени в расстояние (как в pyOTDR/sor-reader):
`dist_km = raw * 1e-4 * c / n`, где `c = 0.299792458 км/мкс`.
Деления на 2 нет — прибор уже хранит одностороннее время.

Тип события: `[0|1|2][A|M|...][4 hex]L[S|E]`.
`FFFF` в средней части — «порог не задан» (встречается `1FFFFFLS`).
Расшифровка: 0 — потери, 1 — отражение, 2 — мульти; A — авто, M — ручное.

## DataPts

```
u32 N
i16 number of traces (1)
u32 N (повтор)
u16 scaling factor × 1e-3
u16[N] raw
```

Уровень: `power = (max(raw) - raw) * scale`.
Ось X: `x_м = i * sampleSpacing * c / n` (в метрах).


