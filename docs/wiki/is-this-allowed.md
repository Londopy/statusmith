# Is this allowed?

Yes. Rich Presence is a feature Discord built for third-party programs, and the Developer
Portal exists so that you can register them. What gets accounts in trouble is automating an
account itself — "self-bots" that use a user's token to send messages, join servers, or set the
text status under the name. Statusmith does none of that, and can't:

- **It never has your token.** It talks to the Discord client already running on your machine
  over the client's local Rich Presence pipe, the same way a game does. Nothing it does could
  act as your account.
- **It sends nothing to Discord's servers itself.** The client relays the card, and the client
  throttles presence to about one update per 15 seconds and drops the rest — there is no rate to
  exceed and nothing to ban.
- **Its network use is tiny and unauthenticated**: two public lookups per application per
  launch (the application's name and its Art Assets, to label things), and one request to GitHub
  for the update check.

The text *custom status* under your name (the one you set in the Discord app) is a different
feature that is only reachable through the account API, which is exactly the self-bot route.
Statusmith doesn't touch it, on purpose.

Tools like this have existed for years — CustomRP, PreMiD, every game launcher's presence
integration — because this is the intended use of the protocol.
