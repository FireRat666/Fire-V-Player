# Deployment & Development Guide

This guide covers setting up a local development environment and deploying the application to a production service like Render.

## Local Development Setup

### Prerequisites

-   [Node.js](https://nodejs.org/) (v20.x or greater, as per `package.json`)
-   npm
-   (Optional) A running PostgreSQL or MySQL instance for testing against a production-like environment.

### Steps

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/FireRat666/Fire-V-Player.git
    cd Fire-V-Player
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Host URL:**
    The client-side scripts need to know the URL of your server. `HOST_URL` in `public/config.js` supports either an array of URLs or a single URL. When multiple URLs are provided, the app automatically detects the matching domain (e.g., `localhost:3000` when running locally, or your production domain when hosted), so you don't need to change `config.js` when switching between environments.
    -   Open the file `public/config.js`.
    -   Ensure `localhost:3000` is included in `HOST_URL`:
    ```javascript
    window.APP_CONFIG = {
      HOST_URL: [
        'vidya.firer.at',
        'localhost:3000'
      ]
    };
    ```

4.  **Set up the database:**
    By default, the application will automatically use a local `db.sqlite` file in the project root, requiring no setup.

5.  **(Optional) Configure for PostgreSQL/MySQL:**
    If you want to test against a remote database locally, create a file named `.env` in the project root. This file is ignored by git. Add your database connection string to it:
    ```bash
    # .env
    DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME"
    ```
    When this file is present, the application will use the specified database instead of SQLite.

6.  **Apply Database Schema:**
    Run the migration command to create the necessary tables in your database (either SQLite or the one from your `.env` file).
    ```bash
    npx sequelize-cli db:migrate
    ```

7.  **Run the server:**
    ```bash
    npm start
    ```
    The server will start, and you can access the application at `http://localhost:3000`.

## Deployment to Render

This application is designed to be easily deployed on Render.

1.  **Fork this repository** to your own GitHub account.

2.  **Create a PostgreSQL Service on Render:**
    -   On your Render dashboard, click "New" -> "PostgreSQL".
    -   Give it a name and choose a region.
    -   **Note:** Render's free tier databases have a **fixed 90-day lifespan**. For a permanent free option, consider an external service like Neon or Supabase and get their connection URL.

3.  **Configure the Host URL before deploying:**
    Before you push your code to GitHub for Render to build, configure your application URL(s) in `public/config.js`. You can specify multiple URLs (e.g., your Render domain, custom domains, and `localhost:3000` for local dev):
    -   Open the file `public/config.js`.
    -   Add your Render service's URL (e.g., `your-app-name.onrender.com`):
    ```javascript
    window.APP_CONFIG = {
      HOST_URL: [
        'your-app-name.onrender.com',
        'localhost:3000'
      ]
    };
    ```

4.  **Create the Web Service on Render:**
    -   On your Render dashboard, click "New" -> "Web Service".
    -   Connect the GitHub repository you forked.
    -   Configure the service:
        -   **Name:** `fire-v-player` (or your choice)
        -   **Region:** Choose the same region as your database for best performance.
        -   **Branch:** `main` (or your default branch)
        -   **Build Command:** `npm install && npx sequelize-cli db:migrate`
        -   **Start Command:** `npm start`

5.  **Link the Environment Variable:**
    -   In your Web Service settings, go to the "Environment" tab.
    -   **If using Render's DB:** Click "Add Environment Group" and select the group associated with your PostgreSQL service. This will automatically create the `DATABASE_URL` variable.
    -   **If using an External DB:** Click "Add Environment Variable". Set the `Key` to `DATABASE_URL` and paste the connection URL from your external provider into the `Value` field.

6.  **Deploy:**
    -   Click "Create Web Service". Render will build your application, which includes running the database migration to set up the necessary tables. Once the build is complete, the service will start.

### Database Maintenance

The application includes an automatic cleanup job that runs every 24 hours. It purges any player instances from the database that have been inactive for more than 7 days, keeping your database lean and performant.

### Automated Database Migration

The application includes a built-in, automated process to migrate your data from one database to another with zero data loss and minimal downtime. This is particularly useful for moving from a temporary database (like Render's free-tier instances which expire after 90 days) to a permanent one.

The migration is triggered by setting both a `DATABASE_URL` (for the old DB) and a `NEW_DATABASE_URL` (for the new DB) environment variable.

#### Migration Steps on Render

1.  **Provision Your New Database:**
    -   Create your new, permanent database (e.g., on Neon, Supabase, or another Render PostgreSQL instance).
    -   Obtain its connection string (URL).

2.  **Set the Migration Variable:**
    -   In your Render Web Service settings, go to the "Environment" tab.
    -   Click "Add Environment Variable".
        -   **Key:** `NEW_DATABASE_URL`
        -   **Value:** Paste the connection URL of your **new** database.

3.  **Trigger the Migration:**
    -   From the Render dashboard, manually restart your web service by going to the "Manual Deploy" menu and selecting "Restart service".
    -   On startup, the application will detect both database URLs, apply the schema to the new database, and copy all data from the old `DATABASE_URL` to the `NEW_DATABASE_URL`.

4.  **Verify Success:**
    -   Go to the "Logs" tab for your service. You should see log messages like `!!! New database URL detected...` followed by `✔✔✔ Application will now use the new database. ✔✔✔`.

5.  **Finalize the Switch:**
    -   Once you've confirmed the migration was successful, go back to the "Environment" tab.
    -   Update the value of the original `DATABASE_URL` variable, replacing it with your **new** database's URL.
    -   **Delete** the `NEW_DATABASE_URL` environment variable.
    -   The service will restart automatically. It will now run exclusively on your new, permanent database. Your old database is no longer used and can be safely deleted.

### Advanced Configuration

#### Improving YouTube Scraper Reliability

YouTube can sometimes block requests from servers, which may cause video search or adding single videos by URL to fail. To make this more reliable, you can provide an authenticated cookie string as an environment variable.

-   **Key:** `YOUTUBE_COOKIE_STRING`
-   **Value:** The full `cookie` string from a browser session logged into YouTube.

**How to get the cookie string:**
1.  Open YouTube in your web browser and log in.
2.  Open your browser's Developer Tools (usually F12).
3.  Go to the "Network" tab, refresh the YouTube page, and click on the first request to `www.youtube.com`.
4.  In the "Headers" section, find the `cookie` request header and copy its entire value.
5.  Set this value for the `YOUTUBE_COOKIE_STRING` environment variable in Render.