import {PlanerSeite} from "./pages/planer";
import {BearbeitenSeite,SchnittSeite} from "./pages/bearbeiten";
import {LiveSeite} from "./pages/live";
import {ZuschauenSeite} from "./pages/zuschauen";
// Routen (Besitzer AP0, Sitzung PA6). Navigation/Platzhalter kommen ausschließlich aus nav.ts.
import { Route, Routes } from "react-router";
import { Shell } from "./components";
import { Geschuetzt, NurEigentuemer, SitzungProvider } from "./lib/sitzung";
import { KONTO_ROUTEN, NAV } from "./nav";
import { AnmeldenSeite, EinladungSeite, KontoSeite } from "./pages/konto";
import { NichtGefunden, Platzhalter } from "./pages/Platzhalter";
import { HochladenSeite } from "./pages/hochladen";
import { ProjekteSeite, ProjektSeite, TranskriptSeite } from "./pages/projekte";
import { StartSeite } from "./pages/start";
import { StudioEinstieg, StudioSeite } from "./pages/studio";
import { VerwaltungSeite } from "./pages/verwaltung";

export function App() {
  return (
    <SitzungProvider>
      <Routes>
        <Route path={KONTO_ROUTEN.anmelden} element={<AnmeldenSeite />} />
        <Route path={KONTO_ROUTEN.einladung} element={<EinladungSeite />} />
        <Route path="/zuschauen" element={<ZuschauenSeite />} />
        <Route element={<Geschuetzt />}>
          <Route path="/studio" element={<StudioEinstieg />} />
          <Route path="/studio/:projektId" element={<StudioSeite />} />
          <Route element={<Shell />}>
            <Route path="/planer" element={<PlanerSeite />} />
<Route path="/bearbeiten" element={<BearbeitenSeite />} />
<Route path="/bearbeiten/:editId" element={<SchnittSeite />} />
<Route path="/live-stream" element={<LiveSeite />} />
<Route index element={<StartSeite />} />
            <Route path="/projekte" element={<ProjekteSeite />} />
            <Route path="/projekte/:projektId" element={<ProjektSeite tab="aufnahmen" />} />
            <Route path="/projekte/:projektId/exporte" element={<ProjektSeite tab="exporte" />} />
            <Route path="/projekte/:projektId/erstellt" element={<ProjektSeite tab="erstellt" />} />
            <Route path="/projekte/:projektId/transkript/:trackId" element={<TranskriptSeite />} />
            <Route path="/hochladen" element={<HochladenSeite />} />
            <Route path={KONTO_ROUTEN.konto} element={<KontoSeite />} />
            <Route path="/verwaltung" element={<NurEigentuemer sonst={<NichtGefunden />}><VerwaltungSeite /></NurEigentuemer>} />
            {NAV.filter((n) => n.status !== "aktiv" && !["/planer","/bearbeiten","/live-stream"].includes(n.path)).map((n) => (
              <Route key={n.path} path={n.path} element={<Platzhalter entry={n} />} />
            ))}
            <Route path="*" element={<NichtGefunden />} />
          </Route>
        </Route>
      </Routes>
    </SitzungProvider>
  );
}
