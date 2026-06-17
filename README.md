# cricket-scorer-functions

Firebase Cloud Functions, Firestore rules, and indexes for the Crease app.

## Getting started

```bash
cd functions
npm install
```

Start the local emulator (imports seed data automatically):

```bash
npm run serve
```

## Deployment

Deploy to production (`crease-24487`):

```bash
# Deploy functions only
firebase deploy --only functions --project crease-24487

# Deploy Firestore rules and indexes only
firebase deploy --only firestore --project crease-24487

# Deploy everything
firebase deploy --project crease-24487
```

The `predeploy` hook runs lint and TypeScript build automatically before each deploy.
