# wePaintAI Core

This project is the core of the wePaintAI application.

## Tech Stack

- **Frontend**: TanStack Start (React 19 + file-based routing)
- **Backend**: Convex (real-time serverless database)
- **Canvas**: [Konva.js](https://konvajs.org/) (2D canvas library with React bindings)
- **Drawing**: [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (smooth drawing strokes)
- **AI Generation**: [Replicate](https://replicate.com/) (AI image generation API)
- **Authentication**: Clerk
- **Deployment**: Vercel (frontend) + Convex Cloud (backend)

## Development Setup

This project uses Vite for the frontend and Convex for the backend.

### Prerequisites

- Node.js (version specified in `.nvmrc` or latest LTS)
- pnpm (latest version)
- Convex account (for cloud deployments)

### Initial Setup

1.  **Install dependencies:**
    ```bash
    pnpm install
    ```

2.  **Convex Login (for cloud deployment, optional for local-only):**
    If you plan to deploy to the Convex cloud, log in:
    ```bash
    npx convex login
    ```
    And then link your project (follow CLI instructions after `npx convex deploy` for the first time or `npx convex link`).

### Running Locally (Default - Free)

To run the application with a **local Convex backend** (no cloud usage, recommended for most development):

```bash
pnpm dev
```

This command will:
1.  Start the Vite frontend development server.
2.  Start a local Convex backend instance using `convex dev --local`.
3.  Your application will connect to `http://127.0.0.1:3210` for Convex services.
4.  Data will be stored locally in the `.convex/local.db` file.

### Running with Convex Cloud (Uses Paid Resources)

If you need to test against your **cloud Convex deployment**:

```bash
pnpm dev:cloud
```

This command will:
1.  Start the Vite frontend development server.
2.  Start the Convex development CLI connected to your designated cloud project (configured via `npx convex link` and `.env.local` or environment variables).
3.  Your application will connect to the Convex URL specified in your `VITE_CONVEX_URL` (typically from `.env.local` pointing to `https://your-project.convex.cloud`).

### Other Useful Scripts

-   **`pnpm build`**: Builds the application for production.
-   **`pnpm start`**: Starts the production server (after building).
-   **`pnpm dev:app`**: Runs only the Vite frontend development server.
-   **`pnpm dev:convex:local`**: Runs only the local Convex backend.
-   **`pnpm dev:convex:cloud`**: Runs only the Convex CLI connected to the cloud.
-   **`pnpm dev:prod-db`**: Runs the local Vite frontend development server connected to the **production Convex database**. Use with caution.

### Environment Variables

-   `VITE_CONVEX_URL`: Specifies the Convex backend URL.
    -   For local development (`pnpm dev`), this should be `http://127.0.0.1:3210` (set in `.env.local`).
    -   For cloud development (`pnpm dev:cloud`), this should point to your `https://<your-project-name>.convex.cloud` URL (usually managed by Convex CLI in `.env.local` after linking).
-   Other `VITE_` prefixed variables can be added to `.env` or `.env.local` as needed.

## Deployment

Deployments are typically handled via Vercel for the frontend and `npx convex deploy` for the Convex backend functions and schema

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.