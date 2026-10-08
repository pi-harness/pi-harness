import { describe, expect, test } from "vitest";
import { useWebsiteStore } from "../src/store.js";

describe("website demo state", () => {
  test("switches workflow stages and toggles the mobile navigation", () => {
    useWebsiteStore.setState({ activeStage: "workspace", mobileMenuOpen: false });

    useWebsiteStore.getState().setActiveStage("plugin");
    useWebsiteStore.getState().toggleMobileMenu();

    expect(useWebsiteStore.getState().activeStage).toBe("plugin");
    expect(useWebsiteStore.getState().mobileMenuOpen).toBe(true);
  });
});
