import type { ClientApi, ClientMarketplacePlugin } from "./control-room.js";

export const loadMarketplaceCatalog = async (api: Pick<ClientApi, "listMarketplace">): Promise<readonly ClientMarketplacePlugin[]> => {
  const items: ClientMarketplacePlugin[] = [];
  for (let page = 0; ; page += 1) {
    const result = await api.listMarketplace("", "", page, 100);
    items.push(...result.items);
    if (!result.hasNext || result.items.length === 0 || items.length >= result.total) return items;
  }
};
