# ☕ The Daily Brew 

## Bean Stack recipe generator

Add a bean with a roast level to preview a hot V60 recipe on the timeline. Select several brew methods to review their recipes one at a time as you save or skip each preview. The generator also supports Japanese iced coffee, standard and inverted AeroPress, AeroPress iced coffee, and AeroPress concentrate. The C3S limits and V60 temperature lookup come from the brewing charts. AeroPress uses provisional roast-based temperatures, with 92°C for medium roast.

The chart-based recipes work without Gemini. To enable optional refinements, open **AI settings** and save a personal Gemini key and model. The preview stays available while Gemini suggests a bounded grind or temperature change. Review the suggestion before applying it. Bean details used for the recommendation go to Google. The key is saved in this browser's local storage and sent to the Gemini API. See [Google's Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key).

For local development, use the Firebase template to create `public/firebase-config.js` with a development Firebase project's web settings, then run `python3 -m http.server 8000 --directory public` and open `http://localhost:8000`. Run `node --test` with Node.js 22 or newer.

### Publish to Bean Stack

Push your branch to the Bean Stack repository and open a pull request for a Firebase preview. Review the recipe flow there, then merge into `main` to publish to [beanstack.web.app](https://beanstack.web.app/). Both workflows run the tests before deploying and use the repository's `FIREBASE_CONFIG_JSON` and `FIREBASE_SERVICE_ACCOUNT_COFFEE_DATABASE_92533` secrets. The preview uses the database from that web configuration.

**The Daily Brew** is a professional-grade coffee recipe builder and smart journal.

This project is a **Universal PWA (Progressive Web App)** that runs on any device (iOS, Android, Desktop). It combines a **Step-by-Step Timeline Builder** with a **Smart Journal** that remembers your beans, lets you rate your brews, and instantly search your entire history—all synced to your personal cloud.

![Status](https://img.shields.io/badge/version-v11.5-blue)
![Hosting](https://img.shields.io/badge/hosting-Netlify-00C7B7)
![Stack](https://img.shields.io/badge/database-Firebase_V11-orange)

## ✨ Features

* **🧠 Smart Bean Memory:** The app "learns" every coffee bean you use. Next time you brew, it auto-suggests the name (e.g., "Ethiopia Guji") instantly.
* **⭐ Star Ratings:** Rate your brews (1-5 Stars) to remember which recipes were perfect and which need tweaking.
* **🔍 Instant Search:** A powerful search bar filters your history by Bean Name, Method, or Notes in milliseconds.
* **🏗️ Visual Recipe Builder:** Create recipes step-by-step (e.g., "Bloom 0:00 → 0:45", "Pour to 150g") with color-coded stages.
* **☁️ Universal Sync:** Build on your laptop, brew with your phone. Data lives in your private Google Firestore.
* **🔒 Secure:** Your API Key is locked to your specific domain, preventing unauthorized use.

---

## 🚀 Setup Guide (Start Here)

Since this app uses a private database, you cannot just "use" a public link to store your personal recipes. **Follow these 4 steps to deploy your own instance in under 10 minutes.**

### Step 1: Get the Code
1.  **Fork this Repository:** Click the **Fork** button (top-right of this page) to create a copy in your own GitHub account.
2.  (Optional) Clone it to your local machine if you want to edit it locally, but you can also edit directly in GitHub.

### Step 2: Set Up Firebase (Your Database)
1.  Go to the [Firebase Console](https://console.firebase.google.com/) and log in with your Google account.
2.  **Create a Project:** Click **Add project** (name it something like `my-coffee-app`).
3.  **Create the Database:**
    * On the left sidebar, go to **Build** → **Firestore Database**.
    * Click **Create Database**.
    * Select **Start in Test Mode** (we will secure it later).
    * Choose a location close to you (e.g., `asia-south1` or `us-central1`).
    * Click **Enable**.
4.  **Get Your Config Code:**
    * Click the **Gear Icon ⚙️** (Project Settings) at the top left.
    * Scroll down to "Your apps".
    * Click the **`</>` (Web)** icon.
    * Give the app a nickname (e.g., "Web App") and click **Register app**.
    * **COPY** the `firebaseConfig` code block (the part between `const firebaseConfig = { ... };`).

### Step 3: Connect the Code
1.  Open the `index.html` file in your GitHub repository.
2.  Scroll down to the bottom script section.
3.  **Replace** the placeholder config with the code you just copied from Firebase.
    ```javascript
    // REPLACE THIS PART
    const firebaseConfig = {
        apiKey: "PASTE_YOUR_API_KEY_HERE",
        authDomain: "coffee-database-92533.firebaseapp.com",
        projectId: "coffee-database-92533",
        storageBucket: "coffee-database-92533.firebasestorage.app",
        messagingSenderId: "788577377347",
        appId: "1:788577377347:web:3ed7f39df2bfb7828348f6"
    };
    ```
4.  **Commit** your changes.

### Step 4: Deploy to Netlify (Free Hosting)
1.  Go to [Netlify.com](https://www.netlify.com/) and sign up (log in with GitHub).
2.  Click **"Add new site"** → **"Import from an existing project"**.
3.  Select **GitHub**.
4.  Search for and select your `Coffee-Recipe` repository.
5.  Click **Deploy Site**.
6.  Netlify will give you a live URL (e.g., `fast-coffee-123.netlify.app`).
    * *Tip: Go to Site Settings > Change site name to make it look nicer.*

---

## 🛡️ Important: Security Rules

Now that your app is live, you must configure the database to accept the new **Version 11.5** data format (which includes Ratings and Search data).

1.  Go back to the **Firebase Console**.
2.  Go to **Build** → **Firestore Database** → **Rules** tab.
3.  **Delete everything** and paste these exact rules:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /recipes/{recipeId} {
      // Allow reading and deleting
      allow read, delete: if true;
      
      // Allow Creating AND Updating (Required for V13 Edit Mode)
      allow create, update: if 
         request.resource.data.coffee is number &&
         request.resource.data.name is string &&
         (request.resource.data.rating is number || request.resource.data.rating == null) &&
         request.resource.data.steps is list;
    }
  }
}
```
🔒 Final Step: API Key Lockdown
To prevent others from using your database quota, lock your API key to your Netlify site.

Go to Google Cloud Credentials.

Find the API Key used in your project and click the Pencil Icon (Edit).

Under Application restrictions, choose Websites.

Add your Netlify URL with a wildcard:

Plaintext
[https://your-site-name.netlify.app/](https://your-site-name.netlify.app/)*
Click Save.

Congratulations! You now have a secure, professional, and private coffee recipe app.

📱 Installation on Mobile
To install as a native app (PWA):

iOS: Open in Safari → Share Icon → "Add to Home Screen".

Android: Open in Chrome → Menu (3 dots) → "Install App" or "Add to Home Screen".

Maintained by Mayank Jaiswal
