---
summary: "Enable Discord Activities and launch OpenClaw A2UI from message components"
read_when:
  - Working on Discord Activities
title: "Discord Activities"
---

# Discord Activities

Discord Activities run a web app inside Discord. OpenClaw can reuse the Gateway A2UI canvas as the Activity UI and launch it from a component button.

## Requirements

- A Discord app with Activities enabled in the developer portal.
- A public HTTPS URL that serves the Gateway A2UI page.
- The Gateway canvas host running and reachable from Discord clients.

## Enable Activities in Discord

<Steps>
  <Step title="Enable Activities">
    In the Discord Developer Portal, open your app and enable Activities under the Embedded App settings.
  </Step>
  <Step title="Set the Activity URL">
    Point the Activity URL to the OpenClaw A2UI host, for example:

    `https://gateway-host.example.com/__openclaw__/a2ui/`

  </Step>
</Steps>

## Expose A2UI from OpenClaw

The Gateway serves A2UI from `/__openclaw__/a2ui/` on the same HTTP server and port as the Gateway. Ensure the canvas host URL is reachable via HTTPS and routed to the Gateway.

Example reverse proxy target:

- Public URL: `https://gateway-host.example.com/__openclaw__/a2ui/`
- Gateway target: `http://gateway-host.example.com:18789/__openclaw__/a2ui/` (replace `18789` with your Gateway port)

If Gateway auth is enabled, configure the activity bridge so Discord can load A2UI without a gateway token:

```json5
{
  canvasHost: {
    activity: {
      enabled: true,
      token: "ACTIVITY_TOKEN",
    },
  },
}
```

Then set the Activity URL to include the token:

`https://gateway-host.example.com/__openclaw__/a2ui/?activityToken=ACTIVITY_TOKEN`

## Send a launch button

Send a message with a component button that uses `action: "launch-activity"`.

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  components: {
    text: "Open the activity",
    blocks: [
      {
        type: "actions",
        buttons: [{ label: "Launch activity", action: "launch-activity" }],
      },
    ],
  },
}
```

When the button is pressed, OpenClaw responds with the `LAUNCH_ACTIVITY` interaction callback and Discord opens the Activity.

## Notes

- The bundled A2UI page renders in Discord, but the node action bridge is not available in the Discord client. If you need Activity user actions to reach the Gateway, add a browser bridge to post actions back to the Gateway.

Related:

- [Discord channel setup](/channels/discord)
