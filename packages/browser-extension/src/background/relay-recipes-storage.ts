// CRUD over chrome.storage.local for chat-relay recipes, prefix-key pattern
// mirroring storage.ts's known-origin entries. chrome.storage.local has no
// native prefix query, so listRecipes fetches everything and filters -
// acceptable at this package's scale (a handful of recipes, not thousands).
import { RELAY_RECIPE_KEY_PREFIX } from '../shared/constants.js';
import type { Recipe } from '../shared/recipe-types.js';

function keyFor(id: string): string {
  return `${RELAY_RECIPE_KEY_PREFIX}${id}`;
}

export async function saveRecipe(recipe: Recipe): Promise<void> {
  await chrome.storage.local.set({ [keyFor(recipe.id)]: recipe });
}

export async function getRecipe(id: string): Promise<Recipe | undefined> {
  const result = await chrome.storage.local.get(keyFor(id));
  return result[keyFor(id)] as Recipe | undefined;
}

export async function deleteRecipe(id: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(id));
}

export async function recipeExists(id: string): Promise<boolean> {
  return (await getRecipe(id)) !== undefined;
}

export async function listRecipes(): Promise<Recipe[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(RELAY_RECIPE_KEY_PREFIX))
    .map(([, value]) => value as Recipe);
}

export async function listRecipeIds(): Promise<Set<string>> {
  const recipes = await listRecipes();
  return new Set(recipes.map((r) => r.id));
}
