import twilio from 'twilio';

let client = null;

// Create the Twilio client only once, when first needed
// (this also makes sure dotenv has already loaded your .env values)
const getClient = () => {
  if (!client) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('Twilio credentials are missing in .env');
    }

    client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return client;
};

// Twilio needs the number in international format: +919876543210
// Examples: "9876543210" -> "+919876543210", "09876543210" -> "+919876543210"
export const formatPhone = (phone) => {
  let digits = String(phone).replace(/[^\d+]/g, ''); // remove spaces, dashes, brackets

  if (digits.startsWith('+')) return digits;          // already international
  digits = digits.replace(/^0+/, '');                 // remove leading 0

  if (digits.length === 10) return `+91${digits}`;    // Indian 10-digit number
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;

  throw new Error(`Invalid phone number: ${phone}`);
};

// Used by notifyBackInStock(). Throws an error if sending fails,
// so the controller keeps the subscription "active" for a retry.

export const sendWhatsAppMessage = async (phone, text) => {
    const to = `whatsapp:${formatPhone(phone)}`;
    const from = process.env.TWILIO_WHATSAPP_FROM;

    if (!from) {
        throw new Error('TWILIO_WHATSAPP_FROM is missing in .env');
    }

    console.log('Preparing WhatsApp message...');
    console.log('Recipient:', to);
    console.log('Sender configured:', Boolean(from));

    const message = await getClient().messages.create({
        from,
        to,
        body: text,
    });

    console.log('Twilio Message SID:', message.sid);
    console.log('Twilio Message Status:', message.status);

    return {
        sid: message.sid,
        status: message.status,
    };
};
