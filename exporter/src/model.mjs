// Normalize a parsed SOR into a report-friendly model.
import { summarize } from "./sor.mjs";

export function toModel(sor, name = "") {
  const s = summarize(sor, name);
  return {
    file: name,
    format: s.format,
    date: sor.fxd.date,
    wavelengthNm: s.wavelengthNm,
    pulseNs: sor.fxd.pulseWidths,
    points: sor.fxd.numDataPoints,
    rangeM: s.rangeM,
    resolutionM: s.resolutionM,
    ior: sor.fxd.indexOfRefraction,
    unit: sor.fxd.unitCode === "km" ? "км" : sor.fxd.unitCode === "m" ? "м" : sor.fxd.unitCode,
    backscatterDb: sor.fxd.backscatterDb,
    numAverages: sor.fxd.numAverages,
    gen: {
      language: sor.gen?.language ?? "",
      cableId: sor.gen?.cableId ?? "",
      fiberId: sor.gen?.fiberId ?? "",
      locationA: sor.gen?.locationA ?? "",
      locationB: sor.gen?.locationB ?? "",
      operator: sor.gen?.operator ?? "",
      comment: sor.gen?.comment ?? "",
      fiberTypeRaw: sor.gen?.fiberTypeRaw ?? 0,
      buildCondition: sor.gen?.buildCondition ?? "",
      cableCodeFiberType: sor.gen?.cableCodeFiberType ?? "",
    },
    sup: {
      supplier: sor.sup?.supplier ?? "",
      otdr: sor.sup?.otdr ?? "",
      otdrSerial: sor.sup?.otdrSerial ?? "",
      module: sor.sup?.module ?? "",
      moduleSerial: sor.sup?.moduleSerial ?? "",
      software: sor.sup?.software ?? "",
      other: sor.sup?.other ?? "",
    },
    events: sor.events.events.map((e) => ({
      number: e.number,
      distanceM: e.distanceM,
      typeRaw: e.typeRaw,
      type: e.type,
      spliceLossDb: e.spliceLossDb,
      reflectionLossDb: e.reflectionLossDb,
      slopeDbPerKm: e.slopeDbPerKm,
      comment: e.comment.trim(),
    })),
    summary: {
      ...sor.events.summary,
      totalLossDb: Number(
        sor.events.events
          .filter((e) => e.distanceM > 1)
          .reduce((a, e) => a + e.spliceLossDb, 0)
          .toFixed(3)
      ),
    },
    checksumOk: sor.checksum?.match ?? null,
    trace: sor.data ? Array.from(sor.data.points) : [],
  };
}
