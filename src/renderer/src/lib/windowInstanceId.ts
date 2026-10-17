/** This window's page-load id: the same across backend reconnects, new on a
 *  reload. A main window sends it with `ui.invoke.ready`, so the backend can
 *  tell which plugin request a still-open window is carrying out (B2-c). */
export const WINDOW_INSTANCE_ID: string = crypto.randomUUID()
