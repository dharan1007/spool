// Versioned mapping recipes. A recipe is a reusable *description*, never an
// authorization: reusing one still requires preflight, dry-run and a fresh bound
// approval for the exact source, plan and target contract.
import { consoleFail } from './errors.js';
import { OPERATOR_VERSION, buildPlanInput, schemaSignature, stripCode, validateMapping } from './plan-builder.js';

export const RECIPE_FORMAT = 'spool-console-recipe-v1';

export function createRecipeService({ engine, store }) {
  function save({ recipeId = null, name, description = null, targetSchema, mapping }) {
    const check = validateMapping({ engine, mapping, targetSchema });
    if (!check.valid) consoleFail('MAPPING_INCOMPLETE', 'Recipe mapping is not valid', { problems: check.problems });
    return store.saveRecipe({
      recipeId,
      name,
      description,
      schemaSignature: schemaSignature(engine, targetSchema),
      targetSchema,
      mapping,
      operatorVersion: OPERATOR_VERSION
    });
  }

  function list({ query = null } = {}) {
    return store.listRecipes({ query });
  }

  function exportRecipe({ recipeId }) {
    const recipe = store.getRecipe(recipeId);
    return {
      format: RECIPE_FORMAT,
      recipe: {
        name: recipe.name,
        description: recipe.description,
        version: recipe.version,
        schemaSignature: recipe.schemaSignature,
        operatorVersion: recipe.operatorVersion,
        targetSchema: recipe.targetSchema,
        mapping: recipe.mapping
      }
    };
  }

  function importRecipe({ text }) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      consoleFail('RECIPE_INCOMPATIBLE', 'Recipe file is not valid JSON');
    }
    if (!parsed || parsed.format !== RECIPE_FORMAT || !parsed.recipe) {
      consoleFail('RECIPE_INCOMPATIBLE', `Recipe file must declare format ${RECIPE_FORMAT}`);
    }
    const recipe = parsed.recipe;
    if (typeof recipe.name !== 'string' || !Array.isArray(recipe.targetSchema) || !Array.isArray(recipe.mapping)) {
      consoleFail('RECIPE_INCOMPATIBLE', 'Recipe file is missing required fields');
    }
    if (recipe.operatorVersion !== OPERATOR_VERSION) {
      consoleFail('RECIPE_INCOMPATIBLE', 'Recipe was created with a different transformation operator version', {
        expected: OPERATOR_VERSION,
        actual: recipe.operatorVersion ?? null
      });
    }
    const saved = save({
      name: recipe.name,
      description: recipe.description ?? null,
      targetSchema: recipe.targetSchema,
      mapping: recipe.mapping
    });
    return { ...saved, compatibility: { status: 'REVIEW_REQUIRED', note: 'Imported recipes never skip preflight, dry-run or approval.' } };
  }

  function apply({ recipeId, targetSchema, sourceHeaders }) {
    const recipe = store.getRecipe(recipeId);
    const expected = schemaSignature(engine, targetSchema);
    if (recipe.schemaSignature !== expected) {
      return {
        status: 'INCOMPATIBLE',
        note: 'Recipe was saved against a different target schema signature.',
        recipe,
        validation: validateMapping({ engine, mapping: recipe.mapping, targetSchema, sourceHeaders })
      };
    }
    const validation = validateMapping({ engine, mapping: recipe.mapping, targetSchema, sourceHeaders });
    return { status: validation.valid ? 'COMPATIBLE' : 'INCOMPLETE', recipe, validation };
  }

  return Object.freeze({ save, list, exportRecipe, importRecipe, apply });
}

export function describeMappingProblems(problems) {
  return (problems ?? []).map(problem => ({ code: problem.code, message: stripCode(problem.message), fields: problem.fields ?? [] }));
}

export { buildPlanInput };
