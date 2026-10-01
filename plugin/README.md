# chassis

The agent plugin of a tool made from the Antasphere tool template. It ships in the tool's own
repository, so the skills travel with the code they describe. Single plugin, Open Plugin v1
layout: this folder is the plugin root.

| Skill                      | When to use it                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `/chassis:instantiate`     | Making a tool out of the template: the inputs, `pnpm instantiate`, its proof, the first commit |
| `/chassis:add-resource`    | Adding a resource to the tool through every slot, the way the placeholder `items` was added    |
| `/chassis:federate-to-hub` | Connecting the tool to the Antasphere hub: the registry entry, the cloud env, the local drill  |
| `/chassis:deploy-on-fleet` | Putting the tool on the Antasphere fleet: the env directory, `deploy.env`, `deploy.yml`, DNS   |

Install it locally from the repository root with `npx plugins add ./plugin`.

The two manifests, `.plugin/plugin.json` and `.claude-plugin/plugin.json`, hold the same content:
edit both together. A skill holds no secret and no internal value, only names and file paths.
Examples use invented names (`examplenotes`, `Example Notes`).
