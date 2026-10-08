import { z } from "zod";

const LinkSchema = z.object({
  label: z.string().min(1),
  href: z.string().min(1),
});

const FeatureSchema = z.object({
  eyebrow: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  signal: z.string().min(1),
});

export const WorkflowStageSchema = z.object({
  id: z.enum(["workspace", "profile", "plugin", "result"]),
  index: z.string().regex(/^0[1-4]$/u),
  label: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  detail: z.string().min(1),
});

export const SiteContentSchema = z.object({
  navigation: z.array(LinkSchema).min(3),
  hero: z.object({
    eyebrow: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    primaryAction: LinkSchema,
    secondaryAction: LinkSchema,
  }),
  features: z.array(FeatureSchema).min(4),
  workflow: z.array(WorkflowStageSchema).length(4),
  install: z.object({
    command: z.string().min(1),
    note: z.string().min(1),
  }),
});

export type SiteContent = z.infer<typeof SiteContentSchema>;
export type WorkflowStageId = z.infer<typeof WorkflowStageSchema.shape.id>;

export const siteContent = {
  navigation: [
    { label: "Product", href: "#product" },
    { label: "Workflow", href: "#workflow" },
    { label: "Docs", href: "/docs" },
    { label: "Plugins", href: "/plugins" },
  ],
  hero: {
    eyebrow: "OPEN SOURCE · LOCAL FIRST · PLUGIN READY",
    title: "Run Pi where your work lives.",
    description: "Pi Harness gives Pi a focused CLI, a real browser console, and a plugin runtime that stays inside the project you already trust.",
    primaryAction: { label: "Install the CLI", href: "#install" },
    secondaryAction: { label: "See the console", href: "#console" },
  },
  features: [
    {
      eyebrow: "01 / RUNTIME",
      title: "One runtime, two surfaces.",
      description: "Move from a fast terminal prompt to a visual session without changing the project or the context behind it.",
      signal: "CLI + console",
    },
    {
      eyebrow: "02 / COMPOSITION",
      title: "Compose the way you work.",
      description: "Profiles turn plugins, tools, models, and guardrails into a project-owned workflow you can inspect and share.",
      signal: "Profiles as code",
    },
    {
      eyebrow: "03 / EXTENSION",
      title: "Make the runtime yours.",
      description: "Build ordinary Cordis plugins against a small contract, then grow a capability without forking the harness.",
      signal: "Plugin-first",
    },
    {
      eyebrow: "04 / BOUNDARIES",
      title: "Local by default.",
      description: "Loopback hosting, explicit project trust, bounded operations, and lifecycle rollback keep the useful power close to home.",
      signal: "Safe defaults",
    },
  ],
  workflow: [
    {
      id: "workspace",
      index: "01",
      label: "Workspace",
      title: "Start at the source.",
      description: "Point Pi Harness at the repository you already understand.",
      detail: "/workspace/pi-harness · main",
    },
    {
      id: "profile",
      index: "02",
      label: "Profile",
      title: "Choose the shape of a session.",
      description: "A project-owned profile decides which capabilities should be present.",
      detail: "default · 14 plugins · trusted",
    },
    {
      id: "plugin",
      index: "03",
      label: "Plugin",
      title: "Add one deliberate capability.",
      description: "Plugins extend the runtime without hiding the system underneath.",
      detail: "workspace-search · ready",
    },
    {
      id: "result",
      index: "04",
      label: "Result",
      title: "Keep the work in reach.",
      description: "The same context is available in the terminal and the browser console.",
      detail: "session · connected · 0 errors",
    },
  ],
  install: {
    command: "npm install --global @pi-harness/pi-harness",
    note: "Node.js 22.19+ · macOS, Linux, and Windows",
  },
} satisfies SiteContent;

SiteContentSchema.parse(siteContent);
