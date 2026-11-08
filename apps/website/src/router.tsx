import { useState } from "react";
import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { siteContent, type WorkflowStageId } from "./content.js";
import { useWebsiteStore } from "./store.js";

const shell = "mx-auto w-[calc(100%-32px)] max-w-[1240px] sm:w-[calc(100%-64px)]";
const arrow = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" className="size-4">
    <path d="M4 10h11M10.5 4.5 16 10l-5.5 5.5" />
  </svg>
);
const darkButton =
  "inline-flex items-center justify-center gap-2 rounded-md bg-[#f3f5f7] px-5 py-3 text-[13px] font-bold text-[#0d1117] transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-2 focus-visible:outline-[#60d9ff] focus-visible:outline-offset-4";

function PiMark({ size = 34, inverse = false }: { size?: number; inverse?: boolean }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-[9px] ${size === 30 ? "size-[30px]" : "size-[34px]"} ${inverse ? "bg-[#f3f5f7] text-[#0d1117]" : "bg-[#111820] text-[#f3f5f7]"}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-[56%]">
        <path d="M7.2 5.6c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5v2.1c0 1.2-.9 2.1-2.1 2.1H7.2V5.6Z" />
        <path d="M12.2 7.7h2.1c1.2 0 2.1.9 2.1 2.1v.3c0 1.2-.9 2.1-2.1 2.1h-2.1" />
        <path d="M8.1 12.2v4.1a3.8 3.8 0 0 0 3.8 3.8h.4a3.8 3.8 0 0 0 3.8-3.8v-4.1" />
        <path d="m7.8 15.6-2.2 2.2M16.2 15.6l2.2 2.2" />
      </svg>
    </span>
  );
}

function Header() {
  const open = useWebsiteStore((state) => state.mobileMenuOpen);
  const toggle = useWebsiteStore((state) => state.toggleMobileMenu);
  const close = useWebsiteStore((state) => state.closeMobileMenu);
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0d1117]/90 text-[#f3f5f7] backdrop-blur-xl">
      <div className={`${shell} flex h-[68px] items-center justify-between`}>
        <Link to="/" onClick={close} className="inline-flex items-center gap-2.5 text-sm font-bold tracking-[-.02em]">
          <PiMark />
          <span>pi harness</span>
        </Link>
        <nav className="hidden items-center gap-8 font-mono text-[11px] uppercase tracking-[.08em] text-[#8c98a5] lg:flex" aria-label="Main navigation">
          <a href="#product" className="hover:text-white">
            Product
          </a>
          <a href="#workflow" className="hover:text-white">
            Workflow
          </a>
          <Link to="/plugins" className="hover:text-white">
            Plugins
          </Link>
          <Link to="/docs" className="hover:text-white">
            Docs
          </Link>
        </nav>
        <div className="hidden items-center gap-5 lg:flex">
          <a
            href="https://github.com/pi-harness/pi-harness"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] uppercase tracking-[.08em] text-[#8c98a5] hover:text-white"
          >
            GitHub
          </a>
          <a
            href="#install"
            className="rounded-md border border-[#3b4a59] px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[.08em] text-[#f3f5f7] hover:border-[#60d9ff] hover:text-[#60d9ff]"
          >
            Install {arrow}
          </a>
        </div>
        <button
          type="button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          onClick={toggle}
          className="grid size-9 place-items-center rounded-md border border-[#3b4a59] lg:hidden"
        >
          <span className="block h-px w-4 bg-white before:mb-1 before:block before:h-px before:w-4 before:bg-white" />
        </button>
      </div>
      {open ? (
        <nav
          className={`${shell} flex flex-col border-t border-white/10 pb-4 pt-3 font-mono text-xs uppercase tracking-[.08em] text-[#9eabb8] lg:hidden`}
          aria-label="Mobile navigation"
        >
          <a href="#product" onClick={close} className="py-3 hover:text-white">
            Product
          </a>
          <a href="#workflow" onClick={close} className="py-3 hover:text-white">
            Workflow
          </a>
          <Link to="/plugins" onClick={close} className="py-3 hover:text-white">
            Plugins
          </Link>
          <Link to="/docs" onClick={close} className="py-3 hover:text-white">
            Docs
          </Link>
          <a href="https://github.com/pi-harness/pi-harness" target="_blank" rel="noreferrer" className="py-3 hover:text-white">
            GitHub
          </a>
        </nav>
      ) : null}
    </header>
  );
}

function ConsolePreview() {
  return (
    <div className="relative overflow-hidden rounded-xl border border-[#465463] bg-[#f6f8fa] shadow-[0_24px_80px_rgba(0,0,0,.4)]">
      <div className="flex h-10 items-center justify-between border-b border-[#d7dde3] bg-white px-3 font-mono text-[10px] text-[#72808c]">
        <span className="flex items-center gap-1.5">
          <i className="size-1.5 rounded-full bg-[#ff9b6b]" />
          <i className="size-1.5 rounded-full bg-[#54c68a]" />
          <i className="size-1.5 rounded-full bg-[#6aa9dc]" />
        </span>
        <span>pi-harness / local console</span>
        <span className="text-[#32976a]">● connected</span>
      </div>
      <img src="/pi-harness-web-console.png" alt="Pi Harness web console" width="1440" height="900" className="block h-auto w-full" />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-[#0d1117] text-[#f3f5f7]">
      <div className={`${shell} relative grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[.72fr_1.28fr] lg:gap-16 lg:py-20`}>
        <div className="max-w-[620px]">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[.16em] text-[#60d9ff]">Pi Harness / local runtime</p>
          <h1 className="mt-5 max-w-[820px] text-[clamp(3.25rem,7vw,6.5rem)] font-bold leading-[.92] tracking-[-.085em]">
            Run Pi where <span className="text-[#60d9ff]">your work lives.</span>
          </h1>
          <p className="mt-6 max-w-[600px] text-[17px] leading-[1.65] text-[#9eabb8]">
            A focused CLI, a real browser console, and a plugin runtime for sessions you can inspect from prompt to patch.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="#install" className={darkButton}>
              Install the CLI {arrow}
            </a>
            <a
              href="#console"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[#3b4a59] px-5 py-3 text-[13px] font-bold text-[#d9e2e9] hover:border-[#60d9ff] hover:text-[#60d9ff]"
            >
              Open the console
            </a>
          </div>
          <div className="mt-8 grid max-w-[500px] grid-cols-3 border-y border-white/10 py-4 font-mono text-[10px] uppercase tracking-[.08em] text-[#758391]">
            <span>
              <b className="block text-[#f3f5f7]">Loopback</b>by default
            </span>
            <span>
              <b className="block text-[#f3f5f7]">Project</b>scoped
            </span>
            <span>
              <b className="block text-[#f3f5f7]">Plugin</b>ready
            </span>
          </div>
        </div>
        <div id="console" className="mt-8 lg:mt-0">
          <ConsolePreview />
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className={`${shell} flex flex-wrap items-center justify-between gap-3 py-4 font-mono text-[10px] uppercase tracking-[.1em] text-[#667482]`}>
          <span>Designed for Pi agent sessions</span>
          <span>Node.js 22.19+ · MIT licensed</span>
        </div>
      </div>
    </section>
  );
}

const outcomes = [
  { label: "Observe", title: "See every turn.", text: "Conversation, tool calls, file changes, and runtime state share one surface." },
  { label: "Compose", title: "Shape the session.", text: "Profiles keep models, plugins, tools, and guardrails close to the project." },
  { label: "Control", title: "Keep the boundary.", text: "Loopback hosting and explicit trust make intervention part of the workflow." },
] as const;

function ProductSection() {
  return (
    <section id="product" className="bg-[#f3f5f7] py-20 text-[#0d1117] sm:py-28">
      <div className={`${shell} flex flex-col gap-5 border-b border-[#cbd3da] pb-10 sm:flex-row sm:items-end sm:justify-between`}>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[.14em] text-[#18728c]">The useful middle layer</p>
          <h2 className="mt-4 max-w-[700px] text-[clamp(2.8rem,5vw,5.5rem)] font-bold leading-[.9] tracking-[-.08em]">
            Enough structure to move faster. Enough visibility to stay in charge.
          </h2>
        </div>
        <p className="max-w-[300px] text-[15px] leading-[1.6] text-[#5e6c78]">Pi Harness turns an agent session into work you can actually follow.</p>
      </div>
      <div className={`${shell} mt-10 grid gap-px overflow-hidden rounded-xl border border-[#cbd3da] bg-[#cbd3da] sm:grid-cols-3`}>
        {outcomes.map((outcome, index) => (
          <article key={outcome.label} className="bg-[#f3f5f7] p-6 sm:p-8">
            <div className="flex items-center justify-between font-mono text-[10px] font-bold uppercase tracking-[.12em] text-[#18728c]">
              <span>{outcome.label}</span>
              <span>0{index + 1}</span>
            </div>
            <h3 className="mt-14 text-2xl font-bold tracking-[-.06em] sm:mt-24">{outcome.title}</h3>
            <p className="mt-3 text-[14px] leading-[1.65] text-[#5e6c78]">{outcome.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function WorkflowSection() {
  const activeStage = useWebsiteStore((state) => state.activeStage);
  const setActiveStage = useWebsiteStore((state) => state.setActiveStage);
  const active = siteContent.workflow.find((stage) => stage.id === activeStage) ?? siteContent.workflow[0];
  if (!active) throw new Error("Website workflow has no stages");
  return (
    <section id="workflow" className="bg-[#dce9ff] py-20 text-[#0d1117] sm:py-28">
      <div className={`${shell} grid gap-12 lg:grid-cols-[.75fr_1.25fr] lg:items-center lg:gap-20`}>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[.14em] text-[#18728c]">01—04 / session path</p>
          <h2 className="mt-4 text-[clamp(2.8rem,5vw,5rem)] font-bold leading-[.9] tracking-[-.08em]">The runtime stays legible.</h2>
          <p className="mt-6 max-w-[390px] text-[16px] leading-[1.65] text-[#526579]">From workspace to result, each state is visible and deliberate.</p>
          <div className="mt-8 flex flex-wrap gap-2" role="tablist" aria-label="Runtime stages">
            {siteContent.workflow.map((stage) => (
              <button
                key={stage.id}
                type="button"
                role="tab"
                aria-selected={stage.id === activeStage}
                onClick={() => setActiveStage(stage.id)}
                className={`rounded-md px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[.08em] transition ${stage.id === activeStage ? "bg-[#0d1117] text-white" : "border border-[#adc3df] text-[#526579] hover:border-[#0d1117] hover:text-[#0d1117]"}`}
              >
                {stage.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[#b8cbe4] bg-[#f8fbff] p-6 shadow-[12px_12px_0_#b8cbe4] sm:p-9">
          <div className="flex items-center justify-between border-b border-[#d5e1ef] pb-4 font-mono text-[10px] uppercase tracking-[.1em] text-[#7a8fa7]">
            <span>Stage {active.index} / 04</span>
            <span className="text-[#2c9c67]">● Ready</span>
          </div>
          <div className="py-16 sm:py-24">
            <p className="font-mono text-[11px] font-bold uppercase tracking-[.12em] text-[#18728c]">{active.label}</p>
            <h3 className="mt-3 text-[clamp(2rem,4vw,4rem)] font-bold leading-[.9] tracking-[-.08em]">{active.title}</h3>
            <p className="mt-4 max-w-[420px] text-[15px] leading-[1.6] text-[#526579]">{active.description}</p>
          </div>
          <div className="border-t border-[#d5e1ef] pt-4 font-mono text-[11px] text-[#7a8fa7]">
            <span>Observed state</span>
            <code className="mt-2 block text-[#0d1117]">{active.detail}</code>
          </div>
        </div>
      </div>
    </section>
  );
}

function PluginSection() {
  return (
    <section className="bg-[#111820] py-20 text-[#f3f5f7] sm:py-28">
      <div className={`${shell} grid gap-12 lg:grid-cols-2 lg:gap-20 lg:items-center`}>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[.14em] text-[#ff9b6b]">02 / extension surface</p>
          <h2 className="mt-4 max-w-[600px] text-[clamp(2.8rem,5vw,5rem)] font-bold leading-[.9] tracking-[-.08em]">
            A runtime you can change without forking.
          </h2>
          <p className="mt-6 max-w-[500px] text-[16px] leading-[1.65] text-[#9eabb8]">
            Use the public plugin contract to add one capability, keep it in a project-owned profile, and make the next session understand why it exists.
          </p>
          <Link
            to="/plugins"
            className="mt-8 inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-[.08em] text-[#ffb18d] hover:text-white"
          >
            Explore the plugin model {arrow}
          </Link>
        </div>
        <div className="overflow-hidden rounded-xl border border-[#344351] bg-[#0d1117] font-mono text-xs shadow-[12px_12px_0_#27343f]">
          <div className="flex items-center gap-2 border-b border-[#344351] px-5 py-3 text-[#687887]">
            <span className="text-[#ff9b6b]">profile.ts</span>
            <span>·</span>
            <span>project-owned</span>
          </div>
          <pre className="overflow-auto p-5 leading-[1.8] text-[#b9c7d3]">
            <code>
              <span className="text-[#60d9ff]">export default</span> <span className="text-[#ffcf7e]">profile</span>({"{\n"}
              <span className="text-[#ff9b6b]"> model</span>: <span className="text-[#a8d897]">"everyapi/auto"</span>,{"\n"}
              <span className="text-[#ff9b6b]"> plugins</span>: [<span className="text-[#a8d897]">"workspace-search"</span>],{"\n"}
              <span className="text-[#ff9b6b]"> trust</span>: <span className="text-[#a8d897]">"explicit"</span>
              {"\n"});
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function InstallSection() {
  const [copied, setCopied] = useState(false);
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(siteContent.install.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section id="install" className="bg-[#ff9b6b] py-16 text-[#0d1117] sm:py-24">
      <div className={`${shell} grid gap-10 lg:grid-cols-[.8fr_1.2fr] lg:items-end lg:gap-20`}>
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[.14em] text-[#7d3f2d]">03 / start local</p>
          <h2 className="mt-4 text-[clamp(2.8rem,5vw,5rem)] font-bold leading-[.9] tracking-[-.08em]">Put the harness next to the work.</h2>
          <p className="mt-5 max-w-[400px] text-[15px] leading-[1.6] text-[#7d3f2d]">
            Install once. Open a repository. Choose the terminal or the Console when the task calls for it.
          </p>
        </div>
        <div>
          <div className="flex items-center gap-3 rounded-lg border border-[#c56d50] bg-[#ffb18d] p-2 pl-4">
            <span className="font-mono text-sm">$</span>
            <code className="min-w-0 flex-1 overflow-auto whitespace-nowrap font-mono text-xs">{siteContent.install.command}</code>
            <button
              type="button"
              onClick={() => void copyCommand()}
              className="shrink-0 rounded-md bg-[#0d1117] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[.08em] text-white"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[.1em] text-[#7d3f2d]">{siteContent.install.note}</p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-[#0d1117] py-10 text-[#8c98a5]">
      <div className={`${shell} flex flex-col justify-between gap-8 sm:flex-row sm:items-end`}>
        <div>
          <div className="inline-flex items-center gap-2.5 text-sm font-bold text-[#f3f5f7]">
            <PiMark size={30} />
            <span>pi harness</span>
          </div>
          <p className="mt-4 max-w-[280px] text-sm leading-[1.6]">A local, inspectable runtime for Pi agent sessions.</p>
        </div>
        <div className="flex flex-wrap gap-5 font-mono text-[10px] uppercase tracking-[.1em]">
          <Link to="/docs" className="hover:text-white">
            Docs
          </Link>
          <Link to="/plugins" className="hover:text-white">
            Plugins
          </Link>
          <a href="https://github.com/pi-harness/pi-harness" target="_blank" rel="noreferrer" className="hover:text-white">
            GitHub
          </a>
          <span>MIT licensed</span>
        </div>
      </div>
    </footer>
  );
}

function RootLayout() {
  return (
    <div className="min-h-screen overflow-x-clip bg-[#0d1117] font-display text-[#f3f5f7]">
      <Header />
      <Outlet />
      <Footer />
    </div>
  );
}
function HomePage() {
  return (
    <main>
      <Hero />
      <ProductSection />
      <WorkflowSection />
      <PluginSection />
      <InstallSection />
    </main>
  );
}

function InfoPage({ kind }: { kind: "docs" | "plugins" | "download" }) {
  const page = {
    docs: {
      kicker: "Documentation",
      title: "Understand the runtime before you extend it.",
      description: "Start with installation, then move into profiles, plugins, the HTTP API, and security boundaries.",
      action: "Open the reference",
      href: "https://github.com/pi-harness/pi-harness/blob/main/docs/README.reference.md",
    },
    plugins: {
      kicker: "Plugin ecosystem",
      title: "A small contract for a larger runtime.",
      description: "Build a Cordis plugin against the public API and compose it into a project-owned profile.",
      action: "Browse plugin source",
      href: "https://github.com/pi-harness/pi-harness/tree/main/packages/plugins",
    },
    download: {
      kicker: "Get Pi Harness",
      title: "Choose the surface that fits the task.",
      description: "Use the CLI for a fast prompt or launch the browser Console for a visible, inspectable session.",
      action: "Install from npm",
      href: "/#install",
    },
  }[kind];
  return (
    <main className={`${shell} min-h-[620px] bg-[#0d1117] py-24`}>
      <p className="font-mono text-[11px] font-bold uppercase tracking-[.14em] text-[#60d9ff]">{page.kicker}</p>
      <h1 className="mt-5 max-w-[820px] text-[clamp(3.5rem,8vw,7rem)] font-bold leading-[.9] tracking-[-.09em]">{page.title}</h1>
      <p className="my-8 max-w-[590px] text-lg leading-[1.6] text-[#9eabb8]">{page.description}</p>
      <a
        className={darkButton}
        href={page.href}
        target={page.href.startsWith("http") ? "_blank" : undefined}
        rel={page.href.startsWith("http") ? "noreferrer" : undefined}
      >
        {page.action} {arrow}
      </a>
    </main>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const docsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs", component: () => <InfoPage kind="docs" /> });
const pluginsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/plugins", component: () => <InfoPage kind="plugins" /> });
const downloadRoute = createRoute({ getParentRoute: () => rootRoute, path: "/download", component: () => <InfoPage kind="download" /> });
const routeTree = rootRoute.addChildren([homeRoute, docsRoute, pluginsRoute, downloadRoute]);
export const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
export type { WorkflowStageId };
