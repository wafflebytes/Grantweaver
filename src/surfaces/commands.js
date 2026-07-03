import { helpBlocks } from './blocks.js';
import { setupModal } from './onboarding.js';
import { db } from '../services/db.js';
import { postDigestNow } from '../services/digest.js';

export function registerCommands(app) {
  app.command('/grantweaver', async ({ ack, command, respond, client, body }) => {
    await ack(); // <3000ms rule
    const sub = (command.text ?? '').trim().split(/\s+/)[0]?.toLowerCase() || 'help';

    if (sub === 'setup') {
      const org = await db.getOrg(command.team_id);
      await client.views.open({ trigger_id: body.trigger_id, view: setupModal(org) });
      return;
    }

    if (sub === 'digest') {
      const org = await db.getOrg(command.team_id);
      if (!org?.digest_channel) {
        return respond({ response_type: 'ephemeral',
          text: 'No digest channel configured yet — run `/grantweaver setup` and pick one. 🧶' });
      }
      await postDigestNow(client, command.team_id);
      return respond({ response_type: 'ephemeral', text: `📬 Digest posted to <#${org.digest_channel}>.` });
    }

    // help + anything unknown → same friendly card (never an error dump)
    return respond({ response_type: 'ephemeral',
      text: 'Grantweaver help', blocks: helpBlocks() });
  });
}
