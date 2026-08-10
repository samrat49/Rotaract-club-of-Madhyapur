# Club Finance Tracker — Backend

Express + Postgres API for the Club Finance Tracker.

## Setup

1. **Create the database** (Postgres must already be running):
   ```
   createdb club_finance
   ```
   If `createdb` isn't on your PATH, use `psql -U postgres -c "CREATE DATABASE club_finance;"`.

2. **Run the schema**:
   ```
   psql -d club_finance -f schema.sql
   ```

3. **Configure environment variables**:
   ```
   cp .env.example .env
   ```
   Edit `.env`: set `DATABASE_URL` to match your local Postgres username/password,
   set `JWT_SECRET` to any long random string, and set `INVITE_CODE` to a code
   you'll share with your officers.

4. **Install dependencies**:
   ```
   npm install
   ```

5. **Start the server**:
   ```
   npm start
   ```
   You should see `Club Finance API running at http://localhost:4000`.

6. **Sanity check**: open `http://localhost:4000/api/health` in a browser —
   you should see `{"ok":true}`.

## Creating officer accounts

There's no signup page yet — for now, register officers with a quick request
(Postman, curl, or the frontend once it's wired up):

```
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Samrat","email":"you@example.com","password":"choose-a-password","inviteCode":"<your INVITE_CODE>"}'
```

Then log in via `/api/auth/login` to get a token used for every other request
(`Authorization: Bearer <token>` header).

## API routes

All routes except `/api/auth/*` require the `Authorization: Bearer <token>` header.

- `POST /api/auth/register` — create an officer account (needs invite code)
- `POST /api/auth/login` — get a token
- `GET/POST /api/members`, `DELETE /api/members/:id`
- `GET/POST /api/events`, `DELETE /api/events/:id`
- `GET/POST /api/transactions`, `POST /api/transactions/bulk`, `DELETE /api/transactions/:id`
- `GET/PUT /api/settings`

## Next step

Once this is running and you can log in successfully, let me know and I'll
update the frontend HTML app to add a login screen and swap `localStorage`
for calls to this API.
