/* ---------- Choir Konnect: per-choir configuration ---------- */
/* Edit everything in this file to brand the app for your own choir.  */
/* Nothing in App.jsx should need to change for a rebrand — it all reads from here. */

export const CHOIR_NAME = "Your Choir Name";          // full name, shown on auth screens
export const CHOIR_NAME_SHORT = "Your Choir";          // short name, used in filenames/print titles/onboarding
export const CHOIR_COUNTRY = "YOUR COUNTRY";           // small caps label under the logo on auth screens

// Paste your own WhatsApp group invite link (or leave blank to hide the WhatsApp button)
export const WHATSAPP_GROUP_LINK = "";

// Generate your own VAPID keypair for push notifications — DO NOT reuse another
// choir's keys. Run: npx web-push generate-vapid-keys
// Paste the PUBLIC key here; the PRIVATE key goes in your push-notification edge function's secrets, not here.
export const VAPID_PUBLIC_KEY = "";

export const PRIVACY_POLICY_TEXT = `Effective Date: [DATE]

At ${CHOIR_NAME}, we value your privacy and are committed to protecting the personal information you provide when using our application. This Privacy Policy explains how we collect, use, store, and safeguard your information.

1. Information We Collect

We may collect the following information:

- Full name
- Email address
- Phone number
- Date of birth
- Residential address
- Profile photograph (where applicable)
- Educational or professional information (if required)
- Device information, such as IP address, browser type, and operating system
- Information about how you use the application

2. How We Use Your Information

We use your information to:

- Create and manage your account.
- Process applications and registrations.
- Communicate important updates and announcements.
- Respond to inquiries and provide support.
- Improve the performance and functionality of the application.
- Maintain the security and integrity of our services.
- Comply with legal obligations where applicable.

3. Data Sharing

We do not sell, rent, or trade your personal information. Your information may be shared only:

- With trusted service providers who help operate the application.
- When required by law or a valid legal process.
- To protect the rights, safety, or property of ${CHOIR_NAME} or its users.

4. Data Security

We implement appropriate technical and organizational measures to protect your personal information from unauthorized access, alteration, disclosure, or destruction. While we strive to use commercially acceptable means to protect your information, no internet-based service can guarantee absolute security.

5. Data Retention

We retain your information only for as long as necessary to provide our services, fulfill legal obligations, resolve disputes, and enforce our policies. When your information is no longer required, it will be securely deleted or anonymized.

6. Your Rights

Depending on applicable laws, you may have the right to:

- Access your personal information.
- Request correction of inaccurate information.
- Request deletion of your personal data.
- Withdraw consent where applicable.
- Contact us regarding any concerns about your privacy.

7. Children's Privacy

Our application is not intended for children under the age required by applicable law without parental or guardian consent. We do not knowingly collect personal information from children without appropriate authorization.

8. Third-Party Services

Our application may use trusted third-party services for hosting, authentication, analytics, notifications, or payment processing. These providers have their own privacy policies governing how they handle your information.

9. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be posted within the application with an updated effective date. Continued use of the application after such updates constitutes acceptance of the revised policy.

10. Contact Us

If you have any questions or concerns regarding this Privacy Policy or the handling of your personal information, please contact us through the official communication channels provided by ${CHOIR_NAME}.

By using this application, you acknowledge that you have read, understood, and agreed to this Privacy Policy.`;

export const ABOUT_TEXT = `${CHOIR_NAME} is a vibrant community of passionate musicians united by a shared commitment to showcasing the beauty, power, and excellence of choral music. Founded on the belief that music is a universal language capable of inspiring hearts and transforming lives, the choir serves as a platform where talent is nurtured, creativity flourishes, and lasting friendships are built.

Our repertoire spans [describe your choir's musical styles/genres here], reflecting both our rich cultural heritage and the timeless traditions of choral excellence. Every performance is approached with artistic integrity, disciplined musicianship, and a deep desire to create meaningful musical experiences for our audiences.

Beyond the stage, ${CHOIR_NAME} is committed to developing singers through musical education, vocal training, mentorship, and collaborative learning. We believe that every rehearsal is an opportunity for growth, every concert is an opportunity to inspire, and every voice contributes to a greater harmony.

As ambassadors of choral music, we strive to promote excellence, preserve musical heritage, foster unity through song, and positively impact our communities. Through our music, we seek not only to entertain but also to uplift, educate, and leave a lasting impression wherever our voices are heard.

Our Vision: [Your choir's vision statement.]

Our Mission: [Your choir's mission statement.]`;
