import { helpBlocks } from './blocks.js';

// TODO: setup + digest subcommands. Help works now so `/grantweaver` never
// dead-ends before the rest of the surface lands.
export function registerCommands(app) {
  app.command('/grantweaver', async ({ ack, respond }) => {
    await ack(); // <3000ms rule
    return respond({ response_type: 'ephemeral', text: 'Grantweaver help', blocks: helpBlocks() });
  });
}
