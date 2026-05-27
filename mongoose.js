const mongoose = require('mongoose');

/**
 * MongoDB Connection Configuration
 * Connects to MongoDB and handles connection events
 */

// MongoDB connection URL - can be configured via environment variable
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cliant-mobile';

// Connection options
const connectionOptions = {
  // These options help with connection stability
  maxPoolSize: 10, // Maximum number of socket connections
  serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
};

/**
 * User Schema Definition
 * Matches the registration form fields from register.ejs
 */
const userSchema = new mongoose.Schema({
  FirstName: { type: String, required: true },
  MiddleName: { type: String },
  LastName: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phoneNumber: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  gender: { type: String },
  county: { type: String },
  constituency: { type: String },
  ward: { type: String },
  ageBracket: { type: String },
  idNumber: { type: String },
  passkey: { type: String },
  startky: { type: String },
  personalPin: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// Pre-save hook: automatically hash plaintext personalPin
userSchema.pre('save', async function(next) {
  // Only hash if personalPin exists and is not already a bcrypt hash
  if (this.personalPin && !this.personalPin.startsWith('$2')) {
    try {
      const bcrypt = require('bcrypt');
      this.personalPin = await bcrypt.hash(this.personalPin, 10);
      console.log(`🔐 Auto-hashed plaintext personalPin for ${this.phoneNumber}`);
    } catch (err) {
      console.error(`❌ Error hashing personalPin: ${err.message}`);
    }
  }
  next();
});

// Create model
const User = mongoose.model('User', userSchema);

/**
 * Connect to MongoDB database
 * @returns {Promise} Mongoose connection promise
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(MONGODB_URI, connectionOptions);
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error(`❌ MongoDB connection error: ${err.message}`);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB reconnected');
    });
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        console.log('MongoDB connection closed through app termination');
        process.exit(0);
      } catch (err) {
        console.error('Error closing MongoDB connection:', err);
        process.exit(1);
      }
    });
    
    return conn;
  } catch (error) {
    console.error(`❌ Error connecting to MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Save user registration to MongoDB
 * @param {Object} userData - User registration data
 * @returns {Promise} Saved user document
 */
const saveUserToMongoDB = async (userData) => {
  try {
    const user = new User(userData);
    await user.save();
    console.log(`✅ User saved to MongoDB: ${user.phoneNumber}`);
    return user;
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error (phone number already exists)
      console.error(`❌ Phone number already registered: ${userData.phoneNumber}`);
      throw new Error('Phone number already registered');
    }
    console.error(`❌ Error saving user to MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Find user by phone number
 * @param {String} phoneNumber - User's phone number
 * @returns {Promise} User document or null
 */
const findUserByPhone = async (phoneNumber) => {
  try {
    return await User.findOne({ phoneNumber });
  } catch (error) {
    console.error(`❌ Error finding user: ${error.message}`);
    throw error;
  }
};

/**
 * Update user's last login time
 * @param {String} phoneNumber - User's phone number
 * @returns {Promise} Updated user document
 */
const updateLastLogin = async (phoneNumber) => {
  try {
    return await User.findOneAndUpdate(
      { phoneNumber },
      { lastLogin: new Date() },
      { new: true }
    );
  } catch (error) {
    console.error(`❌ Error updating last login: ${error.message}`);
    throw error;
  }
};

module.exports = { 
  connectDB, 
  mongoose, 
  User,
  saveUserToMongoDB,
  findUserByPhone,
  updateLastLogin
};
