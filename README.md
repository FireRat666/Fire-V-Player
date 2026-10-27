# Fire-V-Player

## [Setup Guide](https://firer.at/pages/FireVPlayer/)

A collaborative, embeddable YouTube video player designed for virtual worlds inside Banter VR. It allows users to create shared playlists, vote on songs, and watch together in a synchronized real-time environment.

It features a persistent state using a PostgreSQL database, making it suitable for platforms like Render where instances may sleep and restart.

## Features

-   **Two Distinct Modes:** Choose between a collaborative **Playlist Mode** or a turn-based **Karaoke Mode**.
-   **Real-time Sync:** High-precision synchronization of video playback using playback rate adjustments for smooth, sub-second corrections.
-   **Persistent State:** Shared playlists and player settings are saved to a database, surviving server restarts.
-   **Robust Host Controls:** A host can lock the playlist, reorder songs, skip, and manage permissions.
-   **Flexible Permissions:** Features a "Take Over" mode for hostless rooms and a democratic voting system for song selection.
-   **Rich Content:** Easily search YouTube or import entire playlists.
-   **VR-Ready:** Designed for 3D environments with features like volume that fades with distance, in-world UI, and hand controls.
-   **Automated Maintenance:** Stale, inactive instances are automatically purged from the database to keep it lean.

## Documentation

-   **[Usage & Embedding Guide](USAGE.md)**: Learn how to embed the player and see a full reference of all available parameters.
-   **[Deployment Guide](DEPLOYMENT.md)**: Instructions for setting up a local development environment and deploying to production on Render.

## Project Structure

-   `/server`: Contains all backend Node.js code.
    -   `app.js`: The main application entry point, handling WebSocket connections, server logic, and the main tick loop.
    -   `/youtube`: Scraper for searching YouTube.
-   `/public`: Contains all frontend assets served to the client.
    -   `core.js`: A shared library of core functions for creating the player and communicating with the server.
    -   `playlist.js` & `karaoke.js`: The main entry-point scripts for embedding the player into a 3D scene.
    -   `player.js`: Manages the YouTube IFrame Player API, handling playback, sync, and events.
    -   `/playlist` & `/karaoke`: The HTML, CSS, and JS for the separate management UIs.

## License

This project is licensed under the MIT License. See LICENSE.md for details.