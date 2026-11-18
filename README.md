# AOTC Track

Quarterly planning, attendance and reporting system for the Presbyterian
Church of Ghana — Adabraka Official Town Congregation.
Built on the Smart DeonTech mainframe (Blueprint v2, Modules A–K, M).

## Phase 0 (this build)

- Full auth framework: JWT sessions, first-login password change, forgot
  password/email, TOTP 2FA + email/SMS OTP, passkeys, lockout, login logs
- Two seeded admin accounts with 2FA enforced (`npm run seed`)
- AOTC permission catalogue (14 rights) + roles: admin / clerk / secretary / viewer
- Entity scoping middleware (`requireEntityScope`) — committee/group accounts
  can only touch their own data; enforced server-side
- PCG branding: crest, palette (crest blue #1D3F94, red, palm green), AOTC Track naming
- SMS via mNotify (sender ID PCG-AOTC) + SMTP email, both optional/graceful
- Activity log, automatic backups, deploy recipe (nginx + systemd)

## Run it

    npm install
    cp .env.example .env      # set JWT_SECRET (see .env.example) + SMTP/SMS keys
    npm run seed              # creates the 2 admin accounts (edit admin #2 first!)
    npm start                 # http://localhost:3000

## Next phases

1. Committees, groups, signatories, member rosters, goal/KPI import from TYRP
2. Annual planning (activities, targets, costs) + strategic-objective merge
3. Quarterly data entry  4. Report generation (docx/PDF)  5. District Excel fill
6. Attendance  7. Scheduler + reminders  8. Visitors/new members
9. Counselling  10. Dashboards  11. QR check-in

See `SOFTWARE PLAN.md` in the parent folder for the full specification.
