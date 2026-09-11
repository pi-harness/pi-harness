import { basename as fixtureBasename } from 'node:path';
export const SearchFixtureAlpha = 'SEARCH_FIXTURE_NEEDLE';
export function SearchFixtureBeta() {
  return fixtureBasename('/tmp/SEARCH_FIXTURE_NEEDLE');
}
