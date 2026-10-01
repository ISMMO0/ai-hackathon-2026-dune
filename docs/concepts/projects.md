# Projects

A project is a subgroup of a workspace: a name, a description, a list of members, and the items
linked to it. It is how a team that shares one workspace works on one client, one product or one
campaign and finds what belongs to it in one place.

## What a project holds

- **A name and a description.** The description says what the project is for. Agents read it, so
  write it for a reader who has never seen the project.
- **Members**, each with one of three roles.
- **Items**, linked from the item side. An item can sit in several projects at once.

A project belongs to one workspace and never crosses to another.

## The three roles

| Role        | What it can do                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Viewer**  | Read the project and see which items are in it                                                                                 |
| **Editor**  | Everything a viewer can, plus put items in the project                                                                         |
| **Manager** | Everything an editor can, plus rename and describe the project, archive and unarchive it, add and remove members, change roles |

A workspace's owners and admins act as managers on every project of their workspace, whether or not
they are members of it.

Any member of a workspace creates a project and becomes its first manager. Creating one asks for
nothing else.

## Members come from the workspace

Members are added from the workspace's own member list, by email or by user id, and a team of the
workspace is added the same way ([A team as a member](#a-team-as-a-member)). A project is never a way
into the workspace: nobody is invited from outside through it, and adding a stranger's address
answers `404 member_not_found` until that person is a member of the workspace.

A guest can never be a project member (`403 guest_target`). A guest is someone whose only access is
a grant on one resource ([Workspaces](workspaces.md)); a project is a workspace-level grouping, and
it stays closed to them.

A project grant lasts as long as the membership under it. Remove someone from the project, or from
the workspace, and what the project gave them is gone on the next request.

Project membership is managed inside Hackathon Starter on both editions. On cloud, the workspace roster is
managed at Antasphere ([Antasphere account](../getting-started/antasphere-account.md)), but the
projects inside that workspace, and who is in them, stay in Hackathon Starter.

## A team as a member

A team of the workspace (a named group of its people, [Workspaces](workspaces.md#a-workspace-holds-teams))
can be a member of a project, and it holds a role like a person does. Its members hold that role
through the team: add someone to the team and they reach the project, remove them from the team and
their access through it ends on the next request. When a person holds a role of their own and roles
through one or more teams, the highest of them wins. Taking a team off a project leaves its people's
own entries as they are. On a workspace managed by the Antasphere account site, the teams come from
there; putting one on a project is still done in Hackathon Starter.

A team is added with the same call as a person, `POST /api/v1/projects/{id}/members`, naming the
team instead of a member; its role is changed with `PATCH /api/v1/projects/{id}/teams/{teamId}` and
it is taken off with `DELETE /api/v1/projects/{id}/teams/{teamId}`. A team the workspace does not
have answers `404 team_not_found`; a team already on the project answers `409 already_member`. The
project's member list carries people and teams in one list, each entry saying which it is.

The CLI adds a team with `starter projects members add <project> --team <team> --role <role>`, and
`role` and `remove` take `--team` the same way ([CLI reference](../agents/cli.md#projects)).

## A project you are not in answers 404

A project you cannot read answers `404`, never `403`: its name, its roster and what it holds are not
probeable. The same holds for the items list filtered on a project you are not in.

## Archiving

A project is archived, never deleted. Archived, it leaves the default list and becomes read-only:
every change to it and to what it holds through it is refused with `409 project_archived`, except the
unarchive. Nothing cascades onto the items: they stay where they are and keep every other project
they belong to.

## Putting an item in a project

Every member of the workspace reads and writes every item, so a project changes nothing about who
sees an item. It changes where the item is found: the project's page lists the items linked to it,
and every item payload names the projects it sits in that **you** can read.

Linking asks the editor role or more on the project:

```http
PUT /api/v1/items/{id}/projects/{projectId}
```

Unlinking asks the same, because it changes what the project holds too:

```http
DELETE /api/v1/items/{id}/projects/{projectId}
```

Unlinking answers `404 not_linked` when the item was not in the project, and a project you are not
in answers `404` to both routes, so whether an item is in it is not probeable either. A create names
the projects the new item goes in, in the same transaction: one project that does not qualify refuses
the whole create with one `404 project_not_found`, whatever the reason, because a batch is not a
probe.

```json
{
  "projects": [
    { "id": "8c1d…", "name": "Northwind" },
    { "id": "3f7a…", "name": "Q3 campaign" }
  ]
}
```

The CLI has the same verbs (`starter projects link`, `--project` on `items list` and `items
create`: [CLI reference](../agents/cli.md)), and so does the MCP endpoint
([MCP connector](../agents/mcp-connector.md)).

## The API

| Call                                             | What it does                                            |
| ------------------------------------------------ | ------------------------------------------------------- |
| `GET /api/v1/projects`                           | The projects you can read; `?archived=false\|true\|all` |
| `POST /api/v1/projects`                          | Create one; you become its manager                      |
| `GET /api/v1/projects/{id}`                      | One project                                             |
| `PATCH /api/v1/projects/{id}`                    | Rename it, change its description                       |
| `POST /api/v1/projects/{id}/archive`             | Archive it                                              |
| `POST /api/v1/projects/{id}/unarchive`           | Bring it back                                           |
| `GET /api/v1/projects/{id}/members`              | The roster                                              |
| `POST /api/v1/projects/{id}/members`             | Add a workspace member or a team, with a role           |
| `PATCH /api/v1/projects/{id}/members/{userId}`   | Change a member's role                                  |
| `DELETE /api/v1/projects/{id}/members/{userId}`  | Remove a member                                         |
| `PATCH /api/v1/projects/{id}/teams/{teamId}`     | Change a team's role                                    |
| `DELETE /api/v1/projects/{id}/teams/{teamId}`    | Take a team off the project                             |
| `PUT /api/v1/items/{id}/projects/{projectId}`    | Put an item in the project                              |
| `DELETE /api/v1/items/{id}/projects/{projectId}` | Take an item out of the project                         |

`?archived=false` is the default, so a plain `GET /api/v1/projects` lists the live ones.

Every project payload carries `myRole` and `memberCount`, so a client knows what to show without a
second call. `myRole` is the role you hold, or the manager role you hold by being an admin or an
owner of the workspace.

For API keys and agents: reads need `items:read`, writes need `items:write`. There is no scope of
their own for projects, because a project is a way of reading and writing items.

## The refusals

| Answer                          | When                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `404 not_found`                 | The item is not one you can see                                                                      |
| `404 project_not_found`         | No such project, or one you are not a member of                                                      |
| `404 member_not_found`          | On add: nobody in the workspace matches; on a role change or a removal: not a member of this project |
| `404 team_not_found`            | On add: no team of the workspace matches; on a role change or a removal: not on this project         |
| `403 insufficient_project_role` | Your role in the project does not carry the act                                                      |
| `403 guest_target`              | The person named is a guest of the workspace                                                         |
| `403 guest_forbidden`           | You are a guest of the workspace: no project route answers a guest                                   |
| `409 project_archived`          | The project is archived; unarchive it first                                                          |
| `409 already_member`            | That person or team is already in the project                                                        |
| `404 not_linked`                | The item is not in the project, so there is nothing to unlink                                        |
