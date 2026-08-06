/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        shary: "#00B884",
        "shary-dark": "#059669",
        "shary-light": "#E6FAF3",
        // legacy aliases kept temporarily so old dark-theme classes still resolve
        // while screens are migrated one-by-one to the light Shary theme
        gold: "#00B884",
        bgdark: "#0B0B0F",
      },
    },
  },
  plugins: [],
}
