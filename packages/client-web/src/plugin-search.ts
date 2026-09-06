export const matchesPluginQuery = (query: string, fields: readonly (string | undefined)[]): boolean => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return fields.some((field) => field?.toLowerCase().includes(normalized));
};
