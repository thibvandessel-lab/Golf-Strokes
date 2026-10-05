# Matchplay strokes

Kleine website om golfteams samen te stellen en per matchplay-wedstrijd te berekenen hoeveel strokes een team krijgt. De gegevens staan in Supabase, de site zelf draait gratis op GitHub Pages.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De pagina |
| `style.css` | Opmaak |
| `app.js` | Alle logica: aanmelden, gegevens laden en opslaan, berekening |
| `config.js` | Hier vul je de gegevens van je Supabase-project in |
| `supabase/schema.sql` | Tabellen, toegangsregels en live updates |
| `supabase/seed.sql` | Startgegevens: teams, spelers en golfbanen |

## 1. Supabase instellen

1. Maak een gratis account op [supabase.com](https://supabase.com) en maak een nieuw project aan. Kies als regio bijvoorbeeld *Central EU (Frankfurt)*.
2. Open **SQL Editor → New query**, plak de inhoud van `supabase/schema.sql` en klik **Run**.
3. Doe hetzelfde met `supabase/seed.sql`. Voer dit maar één keer uit, anders worden spelers en banen dubbel toegevoegd.
4. Ga naar **Authentication → Sign In / Providers**:
   - laat **Email** aan staan;
   - zet **Allow new users to sign up** uit. Zo kunnen alleen mensen die jij uitnodigt de gegevens zien en wijzigen.
5. Ga naar **Project Settings → API** (of **API Keys**) en kopieer de **Project URL** en de **anon / publishable key**. Vul ze in `config.js` in.

De anon/publishable key mag publiek in GitHub staan. De beveiliging zit in de toegangsregels (Row Level Security): zonder aanmelding kan niemand iets lezen of wijzigen. Zet de **service_role / secret key** nooit in deze bestanden.

## 2. Op GitHub zetten

1. Maak op GitHub een nieuwe repository, bijvoorbeeld `golf-strokes`.
2. Upload alle bestanden uit deze map (via **Add file → Upload files**, of met `git push`). Het lege bestand `.nojekyll` mag mee.
3. Ga naar **Settings → Pages**, kies **Deploy from a branch**, branch `main`, map `/ (root)` en klik **Save**.
4. Na een minuutje staat de site op `https://<jouw-gebruikersnaam>.github.io/golf-strokes/`.

## 3. Inloglinks laten werken

1. In Supabase: **Authentication → URL Configuration**.
2. Zet **Site URL** op het adres van je GitHub Pages-site, bv. `https://<jouw-gebruikersnaam>.github.io/golf-strokes/`.
3. Voeg hetzelfde adres toe bij **Redirect URLs**. Test je ook lokaal, voeg dan ook `http://localhost:3000` toe.

## 4. Medespelers uitnodigen

In Supabase: **Authentication → Users → Add user → Send invitation**, en vul het e-mailadres in. De speler krijgt een mail, klikt op de link en is aangemeld. Daarna kan hij zich altijd opnieuw aanmelden via "Stuur inloglink" op de site.

Supabase verstuurt in het gratis plan maar een beperkt aantal mails per uur. Voor een vriendengroep is dat ruim voldoende. Wil je meer, stel dan onder **Project Settings → Authentication → SMTP** een eigen mailserver in.

## Lokaal testen

```bash
npx serve -l 3000 .
```

Open daarna `http://localhost:3000`.

## Hoe er gerekend wordt

- **Course handicap** = handicap index × slope ÷ 113 + (course rating − par), afgerond.
- **Playing handicap** = course handicap × gekozen percentage, afgerond.
- Het team met de hoogste totale playing handicap krijgt het verschil aan strokes.
- Bij 4BBB en High-Low staat per speler ook het aantal strokes ten opzichte van de laagste playing handicap van de vier.
- Standaardpercentages per formule (altijd aanpasbaar): Single Matchplay 100 %, 4BBB 90 %, High-Low 100 %, Scramble 100 %. Je past ze aan bovenaan in `app.js` (`DEFAULT_PCT`).

Wil je een andere tee als standaard dan MWT, pas dan `DEFAULT_TEE` aan in `app.js`.
