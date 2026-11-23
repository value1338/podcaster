import { describe, expect, it } from "vitest";
import type { Capabilities } from "../../lib/api";
import { erstelltZiel, faehigkeitStatus, leseVorgabe, MAX_BRIEF, NEU, pruefe, ROLLEN, rolleTbd, studioZiel } from "./agenten";

const llm = (state: Capabilities["llm"]["state"]): Capabilities["llm"] =>
  ({ state, provider: state === "ready" ? "openai" : null, model: "m", dataScopes: ["transcript_text", "brief_text"], missing: state === "ready" ? [] : ["OPENAI_API_KEY"] });
const status = (l: Capabilities["llm"] | null) =>
  ROLLEN.flatMap((r) => r.faehigkeiten.filter((f) => faehigkeitStatus(f, l) === "verfuegbar").map((f) => `${r.id}:${f.titel}`));

const ok = { projektId: "p1", neuerProjekttitel: "", episodentitel: "Folge 3", sprecher: "Ric" };

describe("Agentenleiste", () => {
  it("ohne bereiten LLM-Dienst nur Producer › Aufnahme vorbereiten; KI-Aufgaben „Einrichtung fehlt“", () => {
    for (const l of [null, undefined, llm("configuration_required"), llm("unavailable")]) {
      expect(status(l ?? null)).toEqual(["producer:Aufnahme vorbereiten"]);
    }
    const ki = ROLLEN.flatMap((r) => r.faehigkeiten).filter((f) => f.task);
    expect(ki.every((f) => faehigkeitStatus(f, llm("configuration_required")) === "einrichtung")).toBe(true);
    expect(ROLLEN.map((r) => r.name)).toEqual(["Producer", "Editor", "Clipper", "Marketer"]);
  });

  it("mit bereitem LLM: Producer-Ausarbeitung + Marketer; Editor/Clipper bleiben TBD", () => {
    expect(status(llm("ready"))).toEqual([
      "producer:Aufnahme vorbereiten", "producer:Aufnahme ausarbeiten",
      "marketer:Shownotes schreiben", "marketer:Social-Media-Posts entwerfen", "marketer:Newsletter-Text vorschlagen", "marketer:Titel vorschlagen",
    ]);
    expect(ROLLEN.filter(rolleTbd).map((r) => r.id)).toEqual(["editor", "clipper"]);
    // Nur Vertrags-Aufgaben, kein Schnitt aus Text
    const tasks = ROLLEN.flatMap((r) => r.faehigkeiten).map((f) => f.task).filter(Boolean);
    expect(tasks).toEqual(["producer_outline", "shownotes", "social", "marketer_plan", "titles"]);
    expect(erstelltZiel("a/b", "social")).toBe("/projekte/a%2Fb/erstellt?aufgabe=social");
  });

  it("prüft Pflichtfelder und Längen", () => {
    expect(pruefe(ok)).toEqual({});
    expect(Object.keys(pruefe({ ...ok, projektId: "" }))).toEqual(["projekt"]);
    expect(Object.keys(pruefe({ ...ok, projektId: NEU, neuerProjekttitel: "  " }))).toEqual(["neuerProjekttitel"]);
    expect(Object.keys(pruefe({ ...ok, episodentitel: " " }))).toEqual(["episodentitel"]);
    expect(Object.keys(pruefe({ ...ok, episodentitel: "x".repeat(121) }))).toEqual(["episodentitel"]);
    expect(Object.keys(pruefe({ ...ok, sprecher: "x".repeat(121) }))).toEqual(["sprecher"]);
    expect(pruefe({ ...ok, sprecher: "" })).toEqual({});
  });

  it("Übergabe-Route und Rücklesen sind symmetrisch", () => {
    const ziel = studioZiel("a/b", " Folge & 3 ", " Ric ");
    expect(ziel).toBe("/studio/a%2Fb?titel=Folge+%26+3&name=Ric");
    const q = new URLSearchParams(ziel.split("?")[1]);
    expect(leseVorgabe(q, { brief: " Notizen " })).toEqual({ titel: "Folge & 3", name: "Ric", brief: "Notizen" });
    expect(studioZiel("p", "T", " ")).toBe("/studio/p?titel=T");
  });

  it("Vorgabe kürzt und verwirft Ungültiges", () => {
    const v = leseVorgabe(new URLSearchParams({ titel: "x".repeat(300), name: "  " }), { brief: "y".repeat(MAX_BRIEF + 5) });
    expect(v.titel).toHaveLength(120);
    expect(v.name).toBeUndefined();
    expect(v.brief).toHaveLength(MAX_BRIEF);
    expect(leseVorgabe(new URLSearchParams(), null)).toEqual({ titel: undefined, name: undefined, brief: undefined });
    expect(leseVorgabe(new URLSearchParams(), { brief: 5 }).brief).toBeUndefined();
  });
});
