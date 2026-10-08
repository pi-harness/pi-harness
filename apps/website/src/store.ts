import { create } from "zustand";
import type { WorkflowStageId } from "./content.js";

type WebsiteStore = {
  activeStage: WorkflowStageId;
  mobileMenuOpen: boolean;
  setActiveStage: (stage: WorkflowStageId) => void;
  toggleMobileMenu: () => void;
  closeMobileMenu: () => void;
};

export const useWebsiteStore = create<WebsiteStore>()((set) => ({
  activeStage: "workspace",
  mobileMenuOpen: false,
  setActiveStage: (activeStage) => set({ activeStage }),
  toggleMobileMenu: () => set((state) => ({ mobileMenuOpen: !state.mobileMenuOpen })),
  closeMobileMenu: () => set({ mobileMenuOpen: false }),
}));
