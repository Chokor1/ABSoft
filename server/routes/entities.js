import { ENTITY_KINDS, createEntity, deleteEntity, listEntities, updateEntity } from '../entities.js';
import { forbidden } from '../http.js';
import { pageParams, str } from '../util.js';

const adminOnly = (ctx) => {
  if (ctx.user.role !== 'admin') throw forbidden('Administrator access required', 'ADMIN_ONLY');
};

export function register(router) {
  router.get('/api/entity-kinds', () =>
    Object.entries(ENTITY_KINDS).map(([kind, meta]) => ({ kind, contact: meta.contact })),
  );

  // Suggestions while typing. Any signed-in user needs these to ring up a sale.
  router.get('/api/entities/:kind', (ctx) =>
    listEntities(ctx.params.kind, {
      search: str(ctx.query.search),
      all: ctx.query.all === '1',
      page: pageParams(ctx.query, { per: 50 }),
    }),
  );

  router.post('/api/entities/:kind', (ctx) => createEntity(ctx.params.kind, ctx.body));

  // Editing and removing reshape shared lists, so they are administrator work.
  router.put('/api/entities/:kind/:id', (ctx) => {
    adminOnly(ctx);
    return updateEntity(ctx.params.id, ctx.body);
  });

  router.delete('/api/entities/:kind/:id', (ctx) => {
    adminOnly(ctx);
    return deleteEntity(ctx.params.id);
  });
}
