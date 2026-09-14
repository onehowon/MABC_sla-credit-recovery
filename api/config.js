module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null });
};
