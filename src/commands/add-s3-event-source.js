/*global module, require, __dirname, Promise */
var loadConfig = require('../util/loadconfig'),
	readJSON = require('../util/readjson'),
	path = require('path'),
	iamNameSanitize = require('../util/iam-name-sanitize'),
	aws = require('aws-sdk');
module.exports = function addS3EventSource(options) {
	'use strict';
	var lambdaConfig,
		lambda,
		getLambda = function (config) {
			lambda = new aws.Lambda({region: config.lambda.region});
			lambdaConfig = config.lambda;
			return lambda.getFunctionConfiguration({FunctionName: lambdaConfig.name, Qualifier: options.version}).promise();
		},
		readConfig = function () {
			return loadConfig(options, {lambda: {name: true, region: true, role: true}})
				.then(function (config) {
					lambdaConfig = config;
					return config;
				}).then(getLambda)
				.then(function (result) {
					lambdaConfig.arn = result.FunctionArn;
					lambdaConfig.version = result.Version;
				});
		},
		addS3AccessPolicy = function () {
			return readJSON(path.join(__dirname, '..', '..', 'json-templates', 's3-bucket-access.json'))
				.then(function (policy) {
					policy.Statement[0].Resource[0] = policy.Statement[0].Resource[0].replace(/BUCKET_NAME/g, options.bucket);
					return JSON.stringify(policy);
				}).then(function (policyContents) {
					var iam = new aws.IAM();
					return iam.putRolePolicy({
						RoleName: lambdaConfig.role,
						PolicyName: iamNameSanitize('s3-' + options.bucket + '-access'),
						PolicyDocument: policyContents
					}).promise();
				});
		},

		addInvokePermission = function () {
			return lambda.addPermission({
				Action: 'lambda:InvokeFunction',
				FunctionName: lambdaConfig.name,
				Principal: 's3.amazonaws.com',
				SourceArn: 'arn:aws:s3:::' + options.bucket,
				Qualifier: options.version,
				StatementId:  iamNameSanitize(options.bucket  + '-access')
			}).promise();
		},
		addBucketNotificationConfig = function () {
			var s3 = new aws.S3({signatureVersion: 'v4'}),
				eventConfig = {
					LambdaFunctionArn: lambdaConfig.arn,
					Events: ['s3:ObjectCreated:*']
				};
			if (options.prefix) {
				eventConfig.Filter = {
					Key: {
						FilterRules: [{
							Name: 'prefix',
							Value: options.prefix
						}]
					}
				};
			}
			return s3.getBucketNotificationConfiguration({
					Bucket: options.bucket
				}).promise().then(function (currentConfig) {
					var merged = currentConfig || {};
					if (!merged.LambdaFunctionConfigurations) {
						merged.LambdaFunctionConfigurations = [];
					}
					merged.LambdaFunctionConfigurations.push(eventConfig);
					return s3.putBucketNotificationConfiguration({
						Bucket: options.bucket,
						NotificationConfiguration: merged
					}).promise();
				});
		};

	if (!options.bucket) {
		return Promise.reject('bucket name not specified. please provide it with --bucket');
	}

	return readConfig()
		.then(addS3AccessPolicy)
		.then(addInvokePermission)
		.then(addBucketNotificationConfig);
};

module.exports.doc = {
	description: 'Add a notification event to Lambda when a file is added to a S3 bucket, and set up access permissions',
	priority: 4,
	args: [
		{
			argument: 'bucket',
			description: 'S3 Bucket name which will push notifications to Lambda'
		},
		{
			argument: 'prefix',
			optional: true,
			description: 'Prefix filter for S3 keys that will cause the event',
			example : 'infiles/'
		},
		{
			argument: 'version',
			optional: true,
			description: 'Bind to a particular version',
			example: 'production',
			default: 'latest version'
		},
		{
			argument: 'source',
			optional: true,
			description: 'Directory with project files',
			default: 'current directory'
		},
		{
			argument: 'config',
			optional: true,
			description: 'Config file containing the resource names',
			default: 'claudia.json'
		}
	]
};
